import { useEffect, useState, type FormEvent } from 'react'
import { getSetting, setSetting, type SettingKey } from '../db/settings'

// Money settings are stored in centavos but edited in pesos.
const FIELDS: { key: SettingKey; label: string; kind: 'bool' | 'pesos' | 'int' | 'text'; min?: number; max?: number }[] = [
  { key: 'vatRegistered', label: 'VAT-registered café (off = non-VAT)', kind: 'bool' },
  { key: 'dayCutoffHour', label: 'Business day starts at hour (0–23)', kind: 'int', min: 0, max: 23 },
  { key: 'floatCentavos', label: 'Starting float (₱)', kind: 'pesos' },
  { key: 'overShortToleranceCentavos', label: 'Over/short tolerance (₱)', kind: 'pesos' },
  { key: 'smallWaiveCapCentavos', label: 'Small waive cap (₱)', kind: 'pesos' },
  { key: 'cashDropLimitCentavos', label: 'Cash drop limit (₱)', kind: 'pesos' },
  { key: 'cashierDiscountLimitCentavos', label: 'Cashier discount limit (₱, above needs a supervisor)', kind: 'pesos' },
  { key: 'supervisorDiscountLimitCentavos', label: 'Supervisor discount limit (₱, above needs the owner)', kind: 'pesos' },
  { key: 'cashierCompLimitCentavos', label: 'Cashier comp limit (₱, above needs a supervisor)', kind: 'pesos' },
  { key: 'supervisorCompLimitCentavos', label: 'Supervisor comp limit (₱, above needs the owner)', kind: 'pesos' },
  { key: 'employeeDiscountPct', label: 'Staff discount (%)', kind: 'int', min: 0, max: 100 },
  { key: 'employeeDiscountDailyCapCentavos', label: 'Staff discount cap per person per day (₱)', kind: 'pesos' },
  { key: 'autoLockMinutes', label: 'Auto-lock after idle minutes (0 = never)', kind: 'int', min: 0, max: 240 },
  { key: 'longShiftHours', label: 'Flag clock-ins longer than (hours)', kind: 'int', min: 1, max: 48 },
  { key: 'targetMarginPct', label: 'Target margin per drink (%)', kind: 'int', min: 0, max: 100 },
  { key: 'preOrderLeadMinutes', label: 'Remind the bar before a pre-order (minutes)', kind: 'int', min: 0, max: 240 },
  { key: 'bulkOrderDrinks', label: 'Bulk order from this many drinks', kind: 'int', min: 2, max: 500 },
  { key: 'loyaltyMode', label: 'Loyalty: off, stamps or points', kind: 'text' },
  { key: 'loyaltyRewardAt', label: 'Loyalty: stamps or points for one free drink', kind: 'int', min: 1, max: 100000 },
  { key: 'loyaltyPesosPerPoint', label: 'Loyalty (points): pesos paid per point', kind: 'int', min: 1, max: 100000 },
  { key: 'loyaltyExpiryDays', label: 'Loyalty: days until unused stamps or points expire (0 = never)', kind: 'int', min: 0, max: 3650 },
  { key: 'loyaltyWarnDays', label: 'Loyalty: warn this many days before they expire', kind: 'int', min: 0, max: 365 },
  { key: 'loyaltyFastEarnPerDay', label: 'Loyalty: flag a customer earning from more orders than this a day', kind: 'int', min: 1, max: 1000 },
  { key: 'serviceChargePct', label: 'Service charge (%)', kind: 'int', min: 0, max: 100 },
  { key: 'serviceChargeMinGuests', label: 'Offer service charge from this many guests', kind: 'int', min: 1, max: 500 },
  { key: 'staffChargeLimitCentavos', label: 'Staff charge limit per person (₱)', kind: 'pesos' },
  { key: 'queueMinutesPerItem', label: 'Wait estimate: minutes per queued item', kind: 'int', min: 1, max: 60 },
  { key: 'storeName', label: 'Store name (on invoices)', kind: 'text' },
  { key: 'storeTin', label: 'Store TIN', kind: 'text' },
  { key: 'storeAddress', label: 'Store address', kind: 'text' },
  { key: 'platformCommissionPct', label: 'Delivery platform commission (%)', kind: 'int', min: 0, max: 100 },
]

type Form = Record<string, string | boolean>

const toForm = async (): Promise<Form> => {
  const f: Form = {}
  for (const { key, kind } of FIELDS) {
    const v = await getSetting(key)
    f[key] = kind === 'bool' ? Boolean(v) : kind === 'text' ? String(v) : kind === 'pesos' ? String(Number(v) / 100) : String(v)
  }
  return f
}

export default function Settings() {
  const [form, setForm] = useState<Form | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    toForm().then(setForm)
  }, [])
  if (!form) return null

  const save = async (e: FormEvent) => {
    e.preventDefault()
    for (const { key, kind, min, max, label } of FIELDS) {
      const raw = form[key]
      if (kind === 'bool') {
        await setSetting(key, raw as boolean)
        continue
      }
      if (key === 'loyaltyMode' && !['off', 'stamps', 'points'].includes(String(raw).trim().toLowerCase())) {
        setMsg('Loyalty must be off, stamps or points')
        return
      }
      if (kind === 'text') {
        await setSetting(key, key === 'loyaltyMode' ? String(raw).trim().toLowerCase() : String(raw).trim())
        continue
      }
      const n = Number(raw)
      if (raw === '' || !Number.isFinite(n) || n < (min ?? 0) || (max !== undefined && n > max)) {
        setMsg(`Check "${label}"`)
        return
      }
      await setSetting(key, kind === 'pesos' ? Math.round(n * 100) : Math.round(n))
    }
    setMsg('Saved')
  }

  return (
    <>
      <h2>Settings</h2>
      <form onSubmit={save} className="card settings">
        {FIELDS.map(({ key, label, kind }) => (
          <label key={key}>
            {label}
            {kind === 'bool' ? (
              <input
                type="checkbox"
                checked={form[key] as boolean}
                onChange={(e) => { setForm({ ...form, [key]: e.target.checked }); setMsg('') }}
              />
            ) : (
              <input
                inputMode={kind === 'text' ? undefined : 'decimal'}
                value={form[key] as string}
                onChange={(e) => { setForm({ ...form, [key]: e.target.value }); setMsg('') }}
              />
            )}
          </label>
        ))}
        {msg && <p role="status">{msg}</p>}
        <button>Save settings</button>
      </form>
    </>
  )
}
