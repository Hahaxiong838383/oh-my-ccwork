export const TOOL_CONTRACTS = Object.freeze({
  data: Object.freeze({
    gateway: 'permissioned-retrieval-gateway',
    returns: 'permissioned-evidence-package',
    directDatabaseAccess: false,
  }),
  logic: Object.freeze({
    gateway: 'logic-function-gateway',
    deterministicBoundary: true,
    directDatabaseAccess: false,
    directWrite: false,
  }),
  action: Object.freeze({
    gateway: 'mandatory-action-gateway',
    approvalRequired: true,
    directDatabaseAccess: false,
    directWrite: false,
  }),
})
