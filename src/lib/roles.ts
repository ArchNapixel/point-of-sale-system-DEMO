export const ROLES = ['owner', 'supervisor', 'cashier', 'barista', 'trainee'] as const
export type Role = (typeof ROLES)[number]

// Permissions from workflow §12. Add keys as features land.
export type Permission =
  | 'sell' | 'lineVoid' | 'voidPaid' | 'refund' | 'comp' | 'openDay' | 'editStock'
  | 'editPrices' | 'viewQueue' | 'viewAllBranches' | 'trainingOnly'

export const PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ['sell', 'lineVoid', 'voidPaid', 'refund', 'comp', 'openDay', 'editStock', 'editPrices', 'viewQueue', 'viewAllBranches'],
  supervisor: ['sell', 'lineVoid', 'voidPaid', 'refund', 'comp', 'openDay', 'editStock', 'viewQueue'],
  cashier: ['sell', 'lineVoid'],
  barista: ['viewQueue'],
  trainee: ['trainingOnly'],
}

export const can = (role: Role, p: Permission): boolean => PERMISSIONS[role].includes(p)
