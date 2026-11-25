export const ROLES = ['owner', 'supervisor', 'cashier', 'barista', 'trainee'] as const
export type Role = (typeof ROLES)[number]

// Permissions from workflow §12. Add keys as features land.
export type Permission =
  | 'sell' | 'lineVoid' | 'voidPaid' | 'refund' | 'comp' | 'openDay' | 'editStock'
  | 'editPrices' | 'viewQueue' | 'viewAllBranches' | 'trainingOnly' | 'manageSetup' | 'openShift' | 'markSoldOut' | 'verifyPayment' | 'viewDiscountLog' | 'approve' | 'reprint'

export const PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ['manageSetup', 'openShift', 'markSoldOut', 'sell', 'lineVoid', 'voidPaid', 'refund', 'comp', 'openDay', 'editStock', 'editPrices', 'viewQueue', 'viewAllBranches', 'verifyPayment', 'viewDiscountLog', 'approve', 'reprint'],
  supervisor: ['openShift', 'markSoldOut', 'sell', 'lineVoid', 'voidPaid', 'refund', 'comp', 'openDay', 'editStock', 'viewQueue', 'verifyPayment', 'viewDiscountLog', 'approve', 'reprint'],
  cashier: ['openShift', 'markSoldOut', 'sell', 'lineVoid'],
  barista: ['markSoldOut', 'viewQueue'],
  trainee: ['trainingOnly'],
}

export const can = (role: Role, p: Permission): boolean => PERMISSIONS[role].includes(p)
