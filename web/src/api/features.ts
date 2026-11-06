import { useQuery } from "@tanstack/react-query";
import { ledgerApi, matrixEnabled } from "./ledger";
import type { Session } from "./session";

/**
 * Whether Router has Matrix on (agent-router ADR 0005 19.1, `features.matrix`). A Router without the ledger web API is
 * an older Router with Matrix. While the answer is pending, Matrix entries stay hidden; an edge login never has a Matrix
 * account to fall back to, so a failed request hides them too.
 */
export function useMatrixAvailable(session: Session): boolean {
  const me = useQuery({
    queryKey: ["ledger-me", session.token],
    queryFn: ({ signal }) => ledgerApi(session.token).me(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
  return me.isError ? !session.edge : me.data !== undefined && matrixEnabled(me.data);
}
