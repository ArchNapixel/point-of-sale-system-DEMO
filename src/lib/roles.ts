export const ROLES = ['owner', 'supervisor', 'cashier', 'barista', 'trainee'] as const
export type Role = (typeof ROLES)[number]

// Permissions from workflow §12. Add keys as features land.
export type Permission =
  | 'sell' | 'lineVoid' | 'voidPaid' | 'refund' | 'comp' | 'openDay' | 'editStock'
  | 'editPrices' | 'viewQueue' | 'viewAllBranches' | 'trainingOnly' | 'manageSetup' | 'openShift' | 'markSoldOut' | 'verifyPayment' | 'viewDiscountLog' | 'approve' | 'reprint' | 'remake' | 'viewReports'

export const PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ['manageSetup', 'openShift', 'markSoldOut', 'sell', 'lineVoid', 'voidPaid', 'refund', 'comp', 'openDay', 'editStock', 'editPrices', 'viewQueue', 'viewAllBranches', 'verifyPayment', 'viewDiscountLog', 'approve', 'reprint', 'remake', 'viewReports'],
  supervisor: ['openShift', 'markSoldOut', 'sell', 'lineVoid', 'voidPaid', 'refund', 'comp', 'openDay', 'editStock', 'viewQueue', 'verifyPayment', 'viewDiscountLog', 'approve', 'reprint', 'remake', 'viewReports'],
  cashier: ['openShift', 'markSoldOut', 'sell', 'lineVoid'],
  barista: ['markSoldOut', 'viewQueue', 'remake'],
  trainee: ['trainingOnly'],
}

export const can = (role: Role, p: Permission): boolean => PERMISSIONS[role].includes(p)
