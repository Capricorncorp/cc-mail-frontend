import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Check, ArrowLeft } from 'lucide-react'
import client from '@capricorncorp/frontend-platform/api/client'
import { useTheme } from '@capricorncorp/frontend-platform/theme/ThemeProvider'

interface Plan {
  id: string
  name: string
  pricePerUser: number
  features: string[]
  popular?: boolean
}

// The registry returns `features` as an OBJECT (e.g. {storagePerUserGb:10, webmail:true,
// antiSpam:true}), but this page typed it as string[] and .map()'d it directly — crashing
// the whole page (blank screen) once plans actually load. Normalize object|array →
// readable string[] so the plan cards render for either shape.
function featureList(features: any): string[] {
  if (Array.isArray(features)) return features.map(String)
  if (features && typeof features === 'object') {
    return Object.entries(features)
      .filter(([, v]) => v !== false && v !== null && v !== undefined && v !== '')
      .map(([k, v]) => {
        const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim()
        return v === true ? label : `${label}: ${v}`
      })
  }
  return []
}

export default function PricingPage() {
  const navigate = useNavigate()
  const { branding } = useTheme()
  const [plans, setPlans] = useState<Plan[]>([])
  const [loading, setLoading] = useState(true)
  const [userCount, setUserCount] = useState(5)

  useEffect(() => {
    client.get('/registry/products/mail/plans')
      .then(r => {
        setPlans(r.data?.plans || r.data || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const onSelect = (planId: string) => {
    sessionStorage.setItem('selected_plan', planId)
    sessionStorage.setItem('user_count', String(userCount))
    navigate('/signup')
  }

  return (
    <div style={{ minHeight: '100vh', padding: '40px 20px', maxWidth: 1200, margin: '0 auto' }}>
      <Link to="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#666', marginBottom: 32 }}>
        <ArrowLeft size={16} /> Back
      </Link>

      <h1 style={{ fontSize: 48, textAlign: 'center', marginBottom: 16 }}>Mail plans</h1>
      <p style={{ textAlign: 'center', color: '#666', marginBottom: 32 }}>
        Per-user pricing. Add or remove users any time.
      </p>

      {/* User-count slider */}
      <div style={{ maxWidth: 480, margin: '0 auto 48px', padding: 24, background: 'white', borderRadius: 12 }}>
        <div style={{ marginBottom: 12 }}>
          <strong style={{ fontSize: 16 }}>{userCount}</strong> mailbox{userCount === 1 ? '' : 'es'}
        </div>
        <input
          type="range"
          min="1"
          max="50"
          value={userCount}
          onChange={(e) => setUserCount(Number(e.target.value))}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#666', marginTop: 4 }}>
          <span>1</span>
          <span>50+ (contact sales)</span>
        </div>
      </div>

      {loading && <p style={{ textAlign: 'center' }}>Loading plans from the registry...</p>}

      {!loading && plans.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', background: '#fef3c7', borderRadius: 12 }}>
          <p>Plans aren't loaded yet. <Link to="/signup" style={{ textDecoration: 'underline' }}>Get in touch</Link> for a custom plan.</p>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
        {plans.map(plan => (
          <div key={plan.id} style={{
            background: 'white',
            border: `2px solid ${plan.popular ? branding?.primary_color || '#1e3a8a' : '#e0e0e0'}`,
            borderRadius: 12,
            padding: 32,
            position: 'relative',
          }}>
            {plan.popular && (
              <div style={{
                position: 'absolute', top: -12, right: 24,
                background: branding?.primary_color || '#1e3a8a', color: 'white',
                padding: '4px 12px', borderRadius: 12, fontSize: 12, fontWeight: 600,
              }}>POPULAR</div>
            )}
            <h3 style={{ fontSize: 24, marginBottom: 8 }}>{plan.name}</h3>
            <div style={{ fontSize: 36, fontWeight: 700, marginBottom: 4 }}>
              ₹{plan.pricePerUser}<span style={{ fontSize: 16, color: '#666', fontWeight: 400 }}>/user/mo</span>
            </div>
            <div style={{ fontSize: 14, color: '#666', marginBottom: 24 }}>
              ₹{plan.pricePerUser * userCount}/month for {userCount} mailboxes
            </div>
            <ul style={{ listStyle: 'none', marginBottom: 24 }}>
              {featureList(plan.features).map((f, i) => (
                <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                  <Check size={16} color="#22c55e" style={{ marginTop: 4 }} />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <button
              onClick={() => onSelect(plan.id)}
              style={{
                width: '100%', padding: '12px',
                background: plan.popular ? branding?.primary_color || '#1e3a8a' : 'white',
                color: plan.popular ? 'white' : branding?.primary_color || '#1e3a8a',
                border: `2px solid ${branding?.primary_color || '#1e3a8a'}`,
                borderRadius: 6, fontWeight: 600,
              }}
            >
              Get started
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
