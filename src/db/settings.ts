import { db } from './db'
import { pesos } from '../lib/money'

// Every threshold lives here (design rule 7). Owner edits at runtime; these are only fallbacks.
export const DEFAULT_SETTINGS = {
  vatRegistered: true as boolean,
  dayCutoffHour: 4, // sales before 4 AM belong to the previous business date
  floatCentavos: pesos(2000),
  overShortToleranceCentavos: pesos(20),
  smallWaiveCapCentavos: pesos(5),
  cashDropLimitCentavos: pesos(10000),
  platformCommissionPct: 20,
  cashierDiscountLimitCentavos: pesos(300), // a cashier's Senior/PWD discount above this needs a supervisor PIN
  supervisorDiscountLimitCentavos: pesos(2000), // above this, the owner approves
  cashierCompLimitCentavos: pesos(50), // a cashier's comp above this needs a supervisor PIN
  supervisorCompLimitCentavos: pesos(1000), // above this, the owner approves
  employeeDiscountPct: 30, // staff discount, never stacked with Senior/PWD or a promo
  employeeDiscountDailyCapCentavos: pesos(300), // most one employee can save per business day
  autoLockMinutes: 5, // idle time before the screen locks and asks for a PIN; 0 = never
  longShiftHours: 12, // a clock-in running longer than this is flagged for a supervisor to fix
  targetMarginPct: 60, // a drink whose margin (without VAT) falls below this is flagged
  preOrderLeadMinutes: 30, // the bar is reminded this long before a pre-order is due
  bulkOrderDrinks: 10, // a pre-order with this many drinks or more is a bulk order on the timeline
  loyaltyMode: 'off' as string, // off, stamps (buy 9, the 10th free) or points. Loyalty is money we owe, so every rule is a setting.
  loyaltyRewardAt: 9, // stamps or points that buy one free drink
  loyaltyPesosPerPoint: 10, // points mode: one point per this many pesos actually paid
  loyaltyExpiryDays: 365, // 0 = never
  loyaltyWarnDays: 30,
  loyaltyFastEarnPerDay: 6, // a customer earning from more orders than this in one day is flagged
  serviceChargePct: 10, // an optional line for big groups; collected for staff, never part of sales
  serviceChargeMinGuests: 10, // a tab with this many guests is offered the service charge
  staffChargeLimitCentavos: pesos(500), // a staff member may charge this much to their pay account before a supervisor must approve
  queueMinutesPerItem: 2, // wait estimate at the cashier: minutes per waiting item
  storeName: 'DEMO Café',
  storeTin: '000-000-000-000',
  storeAddress: 'Set the address in Settings',
}

export type SettingKey = keyof typeof DEFAULT_SETTINGS

export async function getSetting<K extends SettingKey>(key: K): Promise<(typeof DEFAULT_SETTINGS)[K]> {
  const row = await db.settings.get(key)
  return (row ? row.value : DEFAULT_SETTINGS[key]) as (typeof DEFAULT_SETTINGS)[K]
}

export const setSetting = (key: SettingKey, value: string | number | boolean) => db.settings.put({ key, value })
