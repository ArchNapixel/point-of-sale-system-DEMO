import { can, type Role } from './roles'

// Which sensitive actions need a second person's PIN, and who may give it. Demo thresholds live in settings (rule 7).
export type ApprovalAction = 'discount' | 'reprint'
export type Limits = { discountCashier: number; discountSupervisor: number } // centavos; the owner has no limit

const discountLimit = (role: Role, l: Limits) => (role === 'owner' ? Infinity : role === 'supervisor' ? l.discountSupervisor : role === 'cashier' ? l.discountCashier : 0)

/** Within your limit you act alone (still logged). Above it, or without the permission, someone with the authority must approve. */
export const needsApproval = (role: Role, action: ApprovalAction, amount: number, l: Limits) =>
  action === 'reprint' ? !can(role, 'reprint') : amount > discountLimit(role, l)

/** An approver holds the approve permission, and the amount must be within their own limit too. */
export const canApprove = (role: Role, action: ApprovalAction, amount: number, l: Limits) =>
  can(role, 'approve') && (action === 'reprint' || amount <= discountLimit(role, l))
