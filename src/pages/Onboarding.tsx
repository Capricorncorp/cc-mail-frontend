// Mail Onboarding Wizard
//
// REWRITTEN 2026-05-28: real backend state polling, no setTimeout fakes.
// Polls /api/onboarding/<merchantTransId>/status reading the actual
// ProvisioningJob row updated by CC_Provisioning_Worker. See
// /docs/project-memory.md §17 for the state model.

import { useState, useEffect, useRef } from 'react';
import { Mail, Check, ArrowRight, ArrowLeft,
  ExternalLink, Smartphone, ShieldCheck, BookOpen } from 'lucide-react';
import client from '@capricorncorp/frontend-platform/api/client';
import { useTheme } from '@capricorncorp/frontend-platform/theme/ThemeProvider';
import { StatusChip, stepStateToChipState } from '@capricorncorp/frontend-platform/components/StatusChip';
import { safeRedirect } from '@capricorncorp/frontend-platform/lib/safeRedirect';

// Wave 51: same RFC-1035-ish shape Account Service validates. Kept in sync
// with HostingOnboarding + backend.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

interface Plan {
  id: string;
  name: string;
  monthly: number;
  annual: number;
  popular?: boolean;
  features: Record<string, any>;
  limits: Record<string, any>;
}

interface OnboardingStep {
  name: string;
  ordinal: number;
  state: 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'skipped';
  reason?: string | null;
  error_message?: string | null;
}

interface OnboardingStatus {
  merchantTransId: string;
  product: string;
  plan: string;
  domain: string | null;
  state: 'pending' | 'retrying' | 'propagating' | 'action_required' | 'succeeded' | 'failed';
  reason: string | null;
  expected_resolution: string | null;
  attempts: number;
  max_attempts: number;
  steps: OnboardingStep[];
}

const STEP_LABELS: Record<string, string> = {
  create_cwp_account: 'Create mail server account',
  setup_dkim: 'Generate DKIM signing key',
  create_first_mailbox: 'Create your first mailbox',
  write_db_record: 'Finalize account record',
};

const POLL_INTERVAL_MS = 3000;

function featureList(f: Record<string, any>): string[] {
  if (Array.isArray(f)) return f;
  if (!f || typeof f !== 'object') return [];
  const labels: string[] = [];
  if (f.storagePerUserGb != null) labels.push(`${f.storagePerUserGb} GB / user`);
  if (f.webmail) labels.push('Webmail Access');
  if (f.mobile) labels.push('Mobile (IMAP/POP)');
  if (f.antiSpam) labels.push('Anti-Spam Protection');
  if (f.adminPanel) labels.push('Admin Panel');
  if (f.dkimSpfDmarc) labels.push('DKIM / SPF / DMARC');
  if (f.prioritySupport) labels.push('Priority Support');
  if (f.archiving) labels.push('Email Archiving');
  if (f.auditLogs) labels.push('Audit Logs');
  if (f.dedicatedSupport) labels.push('Dedicated Support Manager');
  if (f.mailboxes != null) labels.push(f.mailboxes === 'Unlimited' ? 'Unlimited Mailboxes' : `${f.mailboxes} Mailbox${f.mailboxes === 1 ? '' : 'es'}`);
  if (f.storagePerBoxGb != null) labels.push(`${f.storagePerBoxGb} GB / mailbox`);
  if (f.aliases != null) labels.push(f.aliases === 'Unlimited' ? 'Unlimited Aliases' : `${f.aliases} Alias${f.aliases === 1 ? '' : 'es'}`);
  if (f.catchAll != null && labels.length < 3) labels.push(f.catchAll ? 'Catch-All Enabled' : 'No Catch-All');
  return labels;
}

// Phase 4b §22.34 — default export for the cc-mail-frontend's
// /onboarding route. goTab below redirects to console.capricorncorp.com
// after provisioning succeeds (mail management lives in Console).
export default function Onboarding({ onComplete }: { onComplete?: () => void } = {}) {
  const { branding } = useTheme();
  const [step, setStep] = useState(1);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<string>('');
  const [period, setPeriod] = useState<'monthly' | 'annual'>('monthly');
  const [domain, setDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [gstPercent, setGstPercent] = useState(18);
  const [merchantTransId, setMerchantTransId] = useState<string | null>(null);
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    client.get('/registry/products/mail/plans')
      .then(res => {
        setPlans(res.data.plans || []);
        setGstPercent(res.data.gstPercent || 18);
      })
      .catch(() => {});
  }, []);

  // Real polling
  useEffect(() => {
    if (step !== 4 || !merchantTransId) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const { data } = await client.get(`/onboarding/${merchantTransId}/status`);
        if (cancelled) return;
        if (data?.job) {
          setStatus(data.job);
          if (data.job.state === 'succeeded' || data.job.state === 'failed') return;
        }
      } catch { /* keep polling */ }
      pollTimer.current = window.setTimeout(poll, POLL_INTERVAL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
  }, [step, merchantTransId]);

  // Resume after PhonePe redirect
  useEffect(() => {
    if (step === 1 && !merchantTransId) {
      try {
        const txn = sessionStorage.getItem('mail_onboarding_txn');
        const urlTxn = new URLSearchParams(window.location.search).get('txn');
        const resumeTxn = urlTxn || txn;
        if (resumeTxn) {
          setMerchantTransId(resumeTxn);
          setStep(4);
        }
      } catch { /* sessionStorage unavailable */ }
    }
  }, [step, merchantTransId]);

  const currentPlan = plans.find(p => p.id === selectedPlan);
  const baseAmount = currentPlan ? (period === 'annual' ? currentPlan.annual : currentPlan.monthly) : 0;
  const tax = Math.round(baseAmount * gstPercent / 100);
  const total = baseAmount + tax;

  async function handleCheckout() {
    setLoading(true);
    setError('');
    try {
      const { data } = await client.post('/billing/orders', {
        product: 'mail',
        plan: selectedPlan,
        period,
        domain,
      });
      if (data.trial || data.devMode) {
        setMerchantTransId(data.merchantTransId);
        setStep(4);
      } else if (data.paymentUrl) {
        if (data.merchantTransId) {
          try { sessionStorage.setItem('mail_onboarding_txn', data.merchantTransId); } catch {}
        }
        // Wave 38: allowlist-validate payment URL before navigating.
        // W125f hotfix: PhonePe V2 Standard Checkout returns a rotating host
        // (mercury-t2.phonepe.com) that the shared safeRedirect allowlist doesn't
        // yet include; the platform fix (@frontend-platform 1.1.1) is blocked on
        // Verdaccio publish auth. PhonePe owns *.phonepe.com, so trust it here for
        // the payment hop ONLY; all other hosts still route through safeRedirect.
        let payHost = '';
        try { payHost = new URL(data.paymentUrl).host.toLowerCase(); } catch { /* fall through */ }
        if (payHost === 'phonepe.com' || payHost.endsWith('.phonepe.com')) {
          window.location.href = data.paymentUrl;
          return;
        }
        const ok = safeRedirect(data.paymentUrl, {
          onUnsafe: (reason) => {
            setError(`We could not start your payment securely (${reason}). Please contact support.`);
          },
        });
        if (!ok) { setLoading(false); return; }
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Payment failed. Please try again.');
    }
    setLoading(false);
  }

  const cardStyle = {
    background: branding.surface_card, borderRadius: 16, padding: 24,
    border: `1px solid ${branding.border_color}`,
  };

  return (
    <div style={{ padding: 'clamp(16px, 4vw, 32px)', maxWidth: 900, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
      <h1 style={{ fontSize: 'clamp(20px, 3.5vw, 24px)', fontWeight: 800, color: branding.text_primary, marginBottom: 4 }}>Get Started with Mail</h1>
      <p style={{ color: branding.text_muted, fontSize: 14, marginBottom: 32 }}>Professional email hosting for your domain</p>

      {/* Progress */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 32, flexWrap: 'wrap' }}>
        {['Select Plan', 'Domain', 'Payment', 'Setup'].map((label, i) => (
          <div key={label} style={{ flex: '1 1 70px', textAlign: 'center', minWidth: 60 }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%', margin: '0 auto 6px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: step > i + 1 ? '#10b981' : step === i + 1 ? branding.primary_color : '#1e293b',
              color: '#fff', fontSize: 13, fontWeight: 700,
            }}>
              {step > i + 1 ? <Check size={14} /> : i + 1}
            </div>
            <div style={{ color: step === i + 1 ? branding.text_primary : '#475569', fontSize: 11, fontWeight: 600 }}>{label}</div>
          </div>
        ))}
      </div>

      {error && <div style={{ background: '#451a1a', color: '#f87171', padding: 12, borderRadius: 10, marginBottom: 16, fontSize: 13 }}>{error}</div>}

      {/* Step 1: Plan Selection */}
      {step === 1 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
            <div style={{ background: '#1e293b', borderRadius: 10, padding: 4, display: 'flex', gap: 2 }}>
              <button onClick={() => setPeriod('monthly')} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: period === 'monthly' ? branding.primary_color : 'transparent', color: branding.text_primary, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Monthly</button>
              <button onClick={() => setPeriod('annual')} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: period === 'annual' ? branding.primary_color : 'transparent', color: branding.text_primary, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Annual <span style={{ color: '#34d399', fontSize: 11 }}>Save 15%+</span></button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
            {plans.map(plan => (
              <div key={plan.id} onClick={() => setSelectedPlan(plan.id)} style={{
                ...cardStyle, cursor: 'pointer',
                border: selectedPlan === plan.id ? `2px solid ${branding.primary_color}` : plan.popular ? '2px solid #8b5cf6' : `1px solid ${branding.border_color}`,
                position: 'relative',
              }}>
                {plan.popular && <div style={{ position: 'absolute', top: -10, right: 16, background: '#8b5cf6', color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 10px', borderRadius: 10 }}>POPULAR</div>}
                <h3 style={{ color: branding.text_primary, fontSize: 18, fontWeight: 700, marginTop: 8, marginBottom: 4 }}>{plan.name}</h3>
                <div style={{ color: branding.primary_color, fontSize: 28, fontWeight: 800, marginBottom: 4 }}>
                  {'₹'}{((period === 'annual' ? plan.annual : plan.monthly) / 100).toFixed(0)}
                  <span style={{ fontSize: 13, color: branding.text_muted, fontWeight: 400 }}>/user/{period === 'annual' ? 'yr' : 'mo'}</span>
                </div>
                <div style={{ fontSize: 11, color: '#475569', marginBottom: 4 }}>+ {gstPercent}% GST</div>
                {(plan as any).description && <div style={{ fontSize: 12, color: branding.text_secondary, marginBottom: 12 }}>{(plan as any).description}</div>}
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {featureList(plan.features).map(f => (
                    <li key={f} style={{ color: branding.text_secondary, fontSize: 13, padding: '4px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Check size={12} color="#10b981" /> {f}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'right', marginTop: 24 }}>
            <button disabled={!selectedPlan} onClick={() => setStep(2)} style={{
              padding: '12px 28px', background: selectedPlan ? branding.primary_color : '#1e293b', color: '#fff',
              border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: selectedPlan ? 'pointer' : 'not-allowed',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              Continue <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Domain */}
      {step === 2 && (
        <div style={cardStyle}>
          <h3 style={{ color: branding.text_primary, fontSize: 18, fontWeight: 700, marginTop: 0, marginBottom: 16 }}>Your Email Domain</h3>
          <p style={{ color: branding.text_muted, fontSize: 13, marginBottom: 20 }}>Enter the domain for your email accounts (e.g. yourcompany.com)</p>
          <div style={{ position: 'relative' }}>
            <Mail size={16} color={branding.text_muted} style={{ position: 'absolute', left: 14, top: 14 }} />
            <input type="text" placeholder="e.g. yourcompany.com" value={domain}
              onChange={e => setDomain(e.target.value.toLowerCase().trim())}
              style={{ width: '100%', padding: '12px 12px 12px 40px', borderRadius: 10, border: `1px solid ${branding.border_color}`, background: branding.surface_input, color: '#fff', fontSize: 15, boxSizing: 'border-box' }}
            />
          </div>
          <div style={{ background: '#0f2340', borderRadius: 10, padding: 16, marginTop: 16, overflow: 'auto' }}>
            <div style={{ color: branding.text_muted, fontSize: 12, fontWeight: 600, marginBottom: 8 }}>DNS RECORDS TO ADD AT YOUR REGISTRAR:</div>
            <div style={{ color: branding.text_primary, fontSize: 13, fontFamily: 'monospace' }}>MX {domain || 'yourdomain.com'} → mail.capricorncorphosting.com (priority 10)</div>
            <div style={{ color: branding.text_primary, fontSize: 13, fontFamily: 'monospace', marginTop: 4 }}>TXT {domain || 'yourdomain.com'} → "v=spf1 include:capricorncorphosting.com ~all"</div>
            <div style={{ color: branding.text_muted, fontSize: 11, marginTop: 8 }}>DKIM + DMARC records will be generated automatically after setup.</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, gap: 12, flexWrap: 'wrap' }}>
            <button onClick={() => setStep(1)} style={{ padding: '12px 24px', background: '#1e293b', color: branding.text_secondary, border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <ArrowLeft size={16} /> Back
            </button>
            <button disabled={!domain || !DOMAIN_RE.test(domain)} onClick={() => setStep(3)} style={{
              padding: '12px 28px', background: domain && DOMAIN_RE.test(domain) ? branding.primary_color : '#1e293b', color: '#fff',
              border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: domain && DOMAIN_RE.test(domain) ? 'pointer' : 'not-allowed',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              Continue <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Payment */}
      {step === 3 && (
        <div style={cardStyle}>
          <h3 style={{ color: branding.text_primary, fontSize: 18, fontWeight: 700, marginTop: 0, marginBottom: 20 }}>Order Summary</h3>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${branding.border_color}` }}>
            <span style={{ color: branding.text_secondary, fontSize: 14 }}>Plan</span>
            <span style={{ color: branding.text_primary, fontSize: 14, fontWeight: 600 }}>{currentPlan?.name} ({period})</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${branding.border_color}` }}>
            <span style={{ color: branding.text_secondary, fontSize: 14 }}>Domain</span>
            <span style={{ color: branding.text_primary, fontSize: 14, fontWeight: 600 }}>{domain}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${branding.border_color}` }}>
            <span style={{ color: branding.text_secondary, fontSize: 14 }}>Subtotal</span>
            <span style={{ color: branding.text_primary, fontSize: 14 }}>{'₹'}{(baseAmount / 100).toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${branding.border_color}` }}>
            <span style={{ color: branding.text_secondary, fontSize: 14 }}>GST ({gstPercent}%)</span>
            <span style={{ color: branding.text_primary, fontSize: 14 }}>{'₹'}{(tax / 100).toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 0' }}>
            <span style={{ color: branding.text_primary, fontSize: 16, fontWeight: 700 }}>Total</span>
            <span style={{ color: branding.primary_color, fontSize: 20, fontWeight: 800 }}>{'₹'}{(total / 100).toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, gap: 12, flexWrap: 'wrap' }}>
            <button onClick={() => setStep(2)} style={{ padding: '12px 24px', background: '#1e293b', color: branding.text_secondary, border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <ArrowLeft size={16} /> Back
            </button>
            <button onClick={handleCheckout} disabled={loading} style={{
              padding: '12px 32px', background: branding.primary_color, color: '#fff',
              border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: loading ? 'wait' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}>
              {loading ? 'Processing…' : `Pay ${'₹'}${(total / 100).toFixed(2)}`}
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Real-state Provisioning */}
      {step === 4 && (
        <MailProvisioningView
          status={status}
          domain={domain || status?.domain || ''}
          branding={branding}
          onComplete={onComplete}
        />
      )}
    </div>
  );
}

function MailProvisioningView({
  status, domain, branding, onComplete,
}: {
  status: OnboardingStatus | null;
  domain: string;
  branding: ReturnType<typeof useTheme>['branding'];
  onComplete?: () => void;
}) {
  const cardStyle = {
    background: branding.surface_card, borderRadius: 16, padding: 24,
    border: `1px solid ${branding.border_color}`,
  };

  if (!status) {
    return (
      <div style={cardStyle}>
        <h3 style={{ color: branding.text_primary, fontSize: 18, fontWeight: 700, marginTop: 0, marginBottom: 4 }}>Setting Up Your Mail</h3>
        <p style={{ color: branding.text_muted, fontSize: 13, marginBottom: 24 }}>{domain}</p>
        <StatusChip state="pending" label="Connecting to provisioning service…" />
      </div>
    );
  }

  const isTerminal = status.state === 'succeeded' || status.state === 'failed';
  const expectedSteps = ['create_cwp_account', 'setup_dkim', 'create_first_mailbox', 'write_db_record'];

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 4 }}>
        <h3 style={{ color: branding.text_primary, fontSize: 18, fontWeight: 700, margin: 0 }}>Setting Up Your Mail</h3>
        <StatusChip state={status.state} />
      </div>
      <p style={{ color: branding.text_muted, fontSize: 13, marginBottom: 8 }}>{domain}</p>
      {status.reason && (
        <p style={{ color: branding.text_secondary, fontSize: 14, marginBottom: 20 }}>{status.reason}</p>
      )}
      {status.expected_resolution && (
        <p style={{ color: branding.text_muted, fontSize: 12, marginBottom: 20 }}>{status.expected_resolution}</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {expectedSteps.map((stepName, idx) => {
          const s = status.steps.find(x => x.name === stepName);
          const label = STEP_LABELS[stepName] || stepName;
          const chipState = stepStateToChipState(s?.state);
          const isInProgress = s?.state === 'in_progress';
          return (
            <div key={stepName} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              padding: '12px 16px', background: '#0f2340', borderRadius: 10, flexWrap: 'wrap',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={{ color: branding.text_muted, fontSize: 12, fontWeight: 700, minWidth: 18 }}>{idx + 1}.</span>
                <span style={{ color: isInProgress ? branding.primary_color : (s?.state === 'succeeded' ? '#34d399' : branding.text_secondary), fontSize: 14, fontWeight: isInProgress ? 600 : 400 }}>
                  {label}
                </span>
              </div>
              <StatusChip
                state={chipState}
                size="sm"
                label={s?.state === 'in_progress' ? 'Working' : s?.state === 'skipped' ? 'Skipped' : undefined}
                reason={s?.reason || s?.error_message || undefined}
              />
            </div>
          );
        })}
      </div>

      {/* Wave 53: concrete "set up your client" quick-start. The customer just
          paid for email — they want to start sending/receiving, not see a
          single button that takes them to a list view. */}
      {status.state === 'succeeded' && (
        <MailQuickStart
          domain={domain} branding={branding}
          onComplete={onComplete}
        />
      )}

      {status.state === 'action_required' && (
        <div style={{ marginTop: 24 }}>
          <div style={{ background: '#3f1d0a', border: '1px solid #f59e0b', borderRadius: 12, padding: 16, marginBottom: 16 }}>
            <div style={{ color: '#fbbf24', fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Action needed: point your MX records</div>
            <p style={{ color: branding.text_secondary, fontSize: 13, margin: 0, lineHeight: 1.6 }}>
              At your DNS provider, add these records for <strong>{domain}</strong>:
            </p>
            <div style={{ marginTop: 12, padding: 12, background: branding.surface_dark, borderRadius: 8, fontFamily: 'monospace', fontSize: 12, color: branding.text_primary, overflow: 'auto' }}>
              MX 10  mail.capricorncorphosting.com<br />
              TXT     "v=spf1 include:capricorncorphosting.com ~all"<br />
              <span style={{ color: branding.text_muted }}>(DKIM + DMARC are generated and shown on the Domain Health page)</span>
            </div>
            <p style={{ color: branding.text_muted, fontSize: 12, marginTop: 12, marginBottom: 0 }}>
              MX propagation is usually within 4 hours. We check every few minutes and will update the status automatically.
            </p>
          </div>
          <button onClick={onComplete} style={{ padding: '12px 32px', background: branding.primary_color, color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', width: '100%' }}>
            Go to Mail Dashboard
          </button>
        </div>
      )}

      {status.state === 'failed' && (
        <div style={{ marginTop: 24, background: '#451a1a', border: '1px solid #ef4444', borderRadius: 12, padding: 16 }}>
          <div style={{ color: '#f87171', fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Provisioning didn't complete</div>
          <p style={{ color: branding.text_secondary, fontSize: 13, margin: 0, lineHeight: 1.6 }}>
            {status.reason || 'Something went wrong during setup.'}
          </p>
          <p style={{ color: branding.text_muted, fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            Your payment is safe. Please contact <a href={`mailto:${branding.support_email}`} style={{ color: branding.primary_color }}>{branding.support_email}</a> with transaction id <code>{status.merchantTransId}</code>.
          </p>
        </div>
      )}

      {status.state === 'retrying' && status.attempts > 0 && (
        <div style={{ marginTop: 16, color: branding.text_muted, fontSize: 12, textAlign: 'center' }}>
          Retry attempt {status.attempts} of {status.max_attempts}
        </div>
      )}

      {!isTerminal && (
        <div style={{ marginTop: 16, fontSize: 11, color: branding.text_muted, textAlign: 'center' }}>
          Refreshing every {Math.round(POLL_INTERVAL_MS / 1000)}s
        </div>
      )}
    </div>
  );
}

// ─── Wave 53: Post-provisioning mail quick-start ─────────────────────────────
//
// Mirrors the HostingOnboarding PostProvisioningSuccess shape but for the
// email-specific journey: webmail launch, IMAP/SMTP settings card, add more
// mailboxes, check Domain Health for MX/SPF/DKIM/DMARC.

function MailQuickStart({
  domain, branding, onComplete,
}: {
  domain: string;
  branding: ReturnType<typeof useTheme>['branding'];
  onComplete?: () => void;
}) {
  // Wave 54: deep-link via ?tab= so each Quick Start card lands the
  // customer exactly where they need to go.
  // Phase 4b §22.34 — customer leaves business-email.capricorncorp.com
  // after provisioning succeeds and goes to Console for ongoing
  // mailbox management.
  // Wave 90 §22.39: renamed from mail.capricorncorp.com to avoid colliding
  // with the production CWP mail server at mail.capricorncorp.com (.201).
  const goTab = (search: string) => {
    const consoleUrl = new URL('https://console.capricorncorp.com/');
    consoleUrl.search = search;
    consoleUrl.hash = '#mail';
    window.location.href = consoleUrl.toString();
    if (onComplete) onComplete();
  };
  const goWebmail = () => goTab('?webmail=1');
  const goAddMailbox = () => goTab('?tab=accounts&new=1');
  const goSettings = () => goTab('?tab=accounts');         // settings card visible on accounts tab
  const goHealth = () => goTab('?tab=health');

  const QuickStartCard = ({
    icon: Icon, title, description, ctaLabel, onClick, accentColor,
  }: {
    icon: any; title: string; description: string; ctaLabel: string;
    onClick: () => void; accentColor: string;
  }) => (
    <button onClick={onClick} style={{
      textAlign: 'left', width: '100%', padding: 16,
      background: branding.surface_dark, border: `1px solid ${branding.border_color}`,
      borderRadius: 12, cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start',
      transition: 'border-color 0.2s',
    }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = accentColor; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = branding.border_color; }}
    >
      <div style={{ background: '#0a1628', borderRadius: 8, padding: 8, flexShrink: 0 }}>
        <Icon size={18} color={accentColor} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: branding.text_primary, fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        <div style={{ color: branding.text_muted, fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}>{description}</div>
        <div style={{ color: accentColor, fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {ctaLabel} <ArrowRight size={12} />
        </div>
      </div>
    </button>
  );

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <Check size={20} color="#10b981" />
          <div style={{ color: branding.text_primary, fontSize: 18, fontWeight: 700 }}>
            Your email is live
          </div>
        </div>
        <div style={{ color: branding.text_muted, fontSize: 13 }}>
          Your first mailbox at <strong style={{ color: branding.text_primary }}>{domain}</strong> is ready. Here's what to do next.
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 12, marginBottom: 16,
      }}>
        <QuickStartCard
          icon={ExternalLink}
          title="Open Webmail"
          description="Sign in with your full email address and the password you set during checkout."
          ctaLabel="Launch Webmail"
          onClick={goWebmail}
          accentColor={branding.primary_color}
        />
        <QuickStartCard
          icon={Smartphone}
          title="Set up on your phone"
          description={`Server: mail.capricorncorphosting.com · IMAP 993 (SSL) · SMTP 465 (SSL). Username is your full email at ${domain}.`}
          ctaLabel="View all settings"
          onClick={goSettings}
          accentColor="#3b82f6"
        />
        <QuickStartCard
          icon={Mail}
          title="Add more mailboxes"
          description={`Create info@, sales@, billing@ — anything you need at @${domain}.`}
          ctaLabel="Add mailbox"
          onClick={goAddMailbox}
          accentColor="#f59e0b"
        />
        <QuickStartCard
          icon={ShieldCheck}
          title="Domain Health"
          description="Confirm MX, SPF, DKIM, and DMARC are propagating correctly — protects your domain from being spoofed."
          ctaLabel="View Domain Health"
          onClick={goHealth}
          accentColor="#10b981"
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginTop: 20 }}>
        <a
          href="https://capricorncorp.com/docs/email-setup"
          target="_blank" rel="noreferrer"
          style={{ color: branding.text_muted, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <BookOpen size={12} /> Email setup guide
        </a>
        <button onClick={onComplete} style={{
          padding: '12px 24px', background: branding.primary_color, color: '#fff',
          border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
          Go to Mail Dashboard <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}
