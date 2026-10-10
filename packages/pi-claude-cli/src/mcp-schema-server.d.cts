/** The JSON-RPC response to one request, or undefined for notifications and unknown methods. */
export function respond(msg: unknown, tools: unknown[]): { jsonrpc: "2.0"; id: unknown; result: Record<string, unknown> } | undefined;
export const HOST_EXECUTION_NOTICE: string;
