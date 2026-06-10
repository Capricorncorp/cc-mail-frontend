// W124 P0 fix — OIDC callback handler for business-email.capricorncorp.com
//
// The mail surface's SignupRedirect previously sent redirect_uri=/onboarding to
// OIDC, but the `mail-frontend` client only registers `/callback`, so every
// "Get started" → sign-in landed on OIDC's "invalid_redirect_uri" error page —
// i.e. NO customer could sign up for mail. (Hosting got this exact fix in
// Wave 96; mail was missed.) This page is the mirror of hosting's Callback.tsx.
//
// Handles `/callback?code=...&state=...`:
//   1. Read code + state from the URL.
//   2. CSRF: compare state with the one SignupRedirect stashed.
//   3. POST gateway /auth/oidc-token with code + redirect_uri=/callback. The
//      gateway exchanges server-to-server (mail-frontend secret) and sets the
//      refresh_token HttpOnly cookie on .capricorncorp.com.
//   4. Restore cart context (selected_plan / user_count) and navigate to a
//      clean /onboarding. (W129: a stale mail_onboarding_txn is NOT resurfaced
//      here — that made a plain sign-in replay a dead, unpaid order.)
//
// IMPORTANT: redirect_uri sent to the gateway MUST match what SignupRedirect
// sent to /auth — both must be `/callback`.

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '@capricorncorp/frontend-platform/theme/ThemeProvider'
import { setAccessToken } from '@capricorncorp/frontend-platform/api/auth'

const GATEWAY_URL =
  (import.meta as any).env?.VITE_GATEWAY_URL || 'https://gateway.capricorncorp.com'

// MUST match what SignupRedirect sent to OIDC's /auth. Hard-coded to /callback
// on the current origin so a stale tab on a different origin can't drift it.
const REDIRECT_URI =
  typeof window !== 'undefined'
    ? `${window.location.origin}/callback`
    : 'https://business-email.capricorncorp.com/callback'

export default function Callback() {
  const navigate = useNavigate()
  const { branding } = useTheme()
  const [error, setError] = useState<string | null>(null)
  // StrictMode mounts effects twice in dev; guard so we don't double-exchange
  // the one-time-use authorization code.
  const exchangedRef = useRef(false)

  useEffect(() => {
    if (exchangedRef.current) return
    exchangedRef.current = true

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const oidcError = params.get('error')
    const oidcErrorDesc = params.get('error_description')
    const returnedState = params.get('state')

    // ── Silent session-detection callback (SurfaceAuth prompt=none) ──────────
    // Distinguished from a real signup by the dedicated `cc_silent_state` marker.
    // This NEVER routes to /onboarding — it only records who the customer is (so the
    // marketing header can greet them) and returns them to where they were. A real
    // signup has no `cc_silent_state`, so it falls straight through to the unchanged
    // flow below.
    let silentState: string | null = null
    try { silentState = sessionStorage.getItem('cc_silent_state') } catch { /* ignore */ }
    if (silentState && returnedState && returnedState === silentState) {
      let ret = '/'
      try {
        sessionStorage.removeItem('cc_silent_state')
        sessionStorage.setItem('cc_silent_tried', '1')
        ret = sessionStorage.getItem('cc_silent_return') || '/'
        sessionStorage.removeItem('cc_silent_return')
      } catch { /* ignore */ }
      if (code) {
        // A shared OIDC session exists — exchange server-side for the profile + tokens,
        // then bounce back (same gateway path the signup flow uses).
        ;(async () => {
          try {
            const res = await fetch(`${GATEWAY_URL}/auth/oidc-token`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code, redirect_uri: REDIRECT_URI }),
            })
            if (res.ok) {
              const data = await res.json()
              if (data?.access_token) setAccessToken(data.access_token, data.expires_in || 900)
              if (data?.user) { try { localStorage.setItem('user_profile', JSON.stringify(data.user)) } catch { /* ignore */ } }
              try { sessionStorage.removeItem('logged_out') } catch { /* ignore */ }
            }
          } catch { /* recognition is best-effort — fall through to logged-out */ }
          window.location.replace(ret)
        })()
      } else {
        // prompt=none returned login_required / no session — just go back, logged out.
        window.location.replace(ret)
      }
      return
    }

    if (oidcError) {
      setError(`Sign-in failed: ${oidcErrorDesc || oidcError}`)
      try { sessionStorage.setItem('mail_oidc_error', oidcErrorDesc || oidcError) } catch {}
      window.setTimeout(() => navigate('/', { replace: true }), 1500)
      return
    }

    if (!code) {
      setError('No authorization code in callback URL.')
      window.setTimeout(() => navigate('/', { replace: true }), 1500)
      return
    }

    // CSRF defense — the state we stashed in SignupRedirect must match the one
    // OIDC echoed back. Mismatch means a foreign authorization code; refuse.
    try {
      const expectedState = sessionStorage.getItem('oauth_state')
      if (expectedState && returnedState && expectedState !== returnedState) {
        setError('Sign-in state did not match. Please try again.')
        window.setTimeout(() => navigate('/', { replace: true }), 1500)
        return
      }
      sessionStorage.removeItem('oauth_state')
    } catch { /* sessionStorage unavailable — proceed without CSRF check */ }

    // Read cart context BEFORE the exchange so we can restore it either way.
    let selectedPlan: string | null = null
    let userCount: string | null = null
    try {
      selectedPlan = sessionStorage.getItem('selected_plan')
      userCount = sessionStorage.getItem('user_count')
    } catch { /* sessionStorage unavailable */ }

    ;(async () => {
      try {
        const res = await fetch(`${GATEWAY_URL}/auth/oidc-token`, {
          method: 'POST',
          credentials: 'include', // refresh_token cookie is set on the response
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirect_uri: REDIRECT_URI }),
        })

        if (!res.ok) {
          let msg = 'Token exchange failed.'
          try {
            const body = await res.json()
            if (body?.message) msg = body.message
          } catch { /* non-json error body */ }
          setError(msg)
          try { sessionStorage.setItem('mail_oidc_error', msg) } catch {}
          window.setTimeout(() => navigate('/', { replace: true }), 1500)
          return
        }

        const data = await res.json()
        if (data?.access_token) {
          setAccessToken(data.access_token, data.expires_in || 900)
        }
        if (data?.user) {
          try { localStorage.setItem('user_profile', JSON.stringify(data.user)) } catch {}
        }

        // Restore cart context for the Onboarding wizard, then go there.
        try {
          if (selectedPlan) sessionStorage.setItem('selected_plan', selectedPlan)
          if (userCount) sessionStorage.setItem('user_count', userCount)
        } catch { /* sessionStorage unavailable */ }

        // W129: do NOT resurface a stale `mail_onboarding_txn` here. In the
        // normal flow the order/txn is created AFTER login (at checkout), so any
        // txn lingering at sign-in is a leftover from a prior abandoned attempt;
        // propagating it made a plain "Sign in" resume a dead, unpaid order and
        // spin "Connecting to provisioning…" forever. A real payment return comes
        // back via the gateway redirect (/onboarding?txn=...), not through here.
        // Clear ?code/?state from the URL bar before the route change.
        window.history.replaceState({}, '', '/callback')
        navigate('/onboarding', { replace: true })
      } catch (err: any) {
        const msg = err?.message || 'Unexpected sign-in error.'
        setError(msg)
        try { sessionStorage.setItem('mail_oidc_error', msg) } catch {}
        window.setTimeout(() => navigate('/', { replace: true }), 1500)
      }
    })()
  }, [navigate])

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: branding?.surface_dark || '#0a1628',
      color: branding?.text_primary || '#fff',
      padding: 16,
    }}>
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <div style={{ fontSize: 12, letterSpacing: 4, color: '#64748b', marginBottom: 16 }}>
          CAPRICORNCORP
        </div>
        {error ? (
          <>
            <h2 style={{ color: '#f87171', fontSize: 20, marginBottom: 12 }}>Sign-in error</h2>
            <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 12 }}>{error}</p>
            <p style={{ color: '#64748b', fontSize: 12 }}>Returning you to the start…</p>
          </>
        ) : (
          <>
            <p style={{ fontSize: 16, marginBottom: 6 }}>Finishing sign-in…</p>
            <p style={{ color: '#64748b', fontSize: 12 }}>Restoring your cart and taking you to onboarding.</p>
          </>
        )}
      </div>
    </div>
  )
}
