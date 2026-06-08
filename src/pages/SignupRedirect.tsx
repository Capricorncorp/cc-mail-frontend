import { useEffect } from 'react'

export default function SignupRedirect() {
  useEffect(() => {
    const clientId = 'mail-frontend'
    // MUST be /callback — the only redirect_uri registered for the mail-frontend
    // OIDC client. /onboarding (the old value) returns invalid_redirect_uri and
    // blocked every mail signup. Callback.tsx does the token exchange → /onboarding.
    const redirectUri = encodeURIComponent('https://business-email.capricorncorp.com/callback')
    const state = encodeURIComponent(crypto.randomUUID())
    sessionStorage.setItem('oauth_state', state)
    window.location.href =
      `https://auth.capricorncorp.com/auth?response_type=code&` +
      `client_id=${clientId}&redirect_uri=${redirectUri}&` +
      `state=${state}&scope=openid+profile+email`
  }, [])
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <p>Redirecting to sign in...</p>
        <p style={{ color: '#666', marginTop: 8 }}>If you're not redirected, <a href="https://auth.capricorncorp.com/auth">click here</a>.</p>
      </div>
    </div>
  )
}
