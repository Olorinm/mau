import { useQuery } from "@tanstack/react-query";
import { ledgerApi, matrixEnabled } from "./ledger";
import type { Session } from "./session";

/**
 * Whether Router has Matrix on (agent-router ADR 0005 19.1, `features.matrix`), so Matrix can be offered as a message
 * channel. While the answer is pending, or when the request fails, Matrix entries stay hidden.
 */
export function useMatrixAvailable(session: Session): boolean {
  const me = useQuery({
    queryKey: ["ledger-me", session.token],
    queryFn: ({ signal }) => ledgerApi(session.token).me(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
  return me.data !== undefined && matrixEnabled(me.data);
}
