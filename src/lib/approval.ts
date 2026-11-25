import { can, type Role } from './roles'

// Which sensitive actions need a second person's PIN, and who may give it. Demo thresholds live in settings (rule 7).
// discount / comp: within your limit you act alone (still logged). void / refund: always need a PIN, even for a supervisor (then it is flagged self-approved).
export type ApprovalAction = 'discount' | 'reprint' | 'comp' | 'void' | 'refund' | 'cash' | 'walkout' | 'loyalty' | 'charge'
export type Limits = { discountCashier: number; discountSupervisor: number; compCashier: number; compSupervisor: number } // centavos; the owner has no limit
export const NO_LIMITS: Limits = { discountCashier: 0, discountSupervisor: 0, compCashier: 0, compSupervisor: 0 }

const limitOf = (role: Role, action: ApprovalAction, l: Limits) =>
  role === 'owner' ? Infinity
    : role === 'supervisor' ? (action === 'comp' ? l.compSupervisor : l.discountSupervisor)
      : role === 'cashier' ? (action === 'comp' ? l.compCashier : l.discountCashier)
        : 0

export const needsApproval = (role: Role, action: ApprovalAction, amount: number, l: Limits) =>
  action === 'reprint' ? !can(role, 'reprint') : action === 'void' || action === 'refund' || action === 'cash' || action === 'walkout' || action === 'loyalty' || action === 'charge' ? true : amount > limitOf(role, action, l)

/** An approver holds the approve permission, and for discounts and comps the amount must be within their own limit too. */
export const canApprove = (role: Role, action: ApprovalAction, amount: number, l: Limits) =>
  can(role, 'approve') && (action === 'discount' || action === 'comp' ? amount <= limitOf(role, action, l) : true)
