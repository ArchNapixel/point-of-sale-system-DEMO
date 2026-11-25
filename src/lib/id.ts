// IDs are made on the device so offline sync can't create duplicates (design rule 5).
export const newId = (): string => crypto.randomUUID()
