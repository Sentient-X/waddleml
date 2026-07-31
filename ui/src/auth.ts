// Auth hooks built on react-query. The session lives in the platform's
// HTTP-only `sx_session` cookie; `useMe` reflects it, logout clears it both
// centrally and here. Signing in happens on the platform's one hosted login
// view (sx_authd /login) — the console renders no password form.
import { createAuthHooks } from "@sx/api-client";

import { waddleApi } from "./api/client";
import type { CurrentUser } from "./api/types";

const hooks = createAuthHooks<CurrentUser>({
  me: () => waddleApi.me(),
  logout: () => waddleApi.logout().then(() => undefined),
});

export const useMe = hooks.useMe;
export const useLogout = hooks.useLogout;
