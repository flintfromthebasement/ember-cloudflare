import { createContext, useContext } from "react";
import type { MembershipProvider } from "@ember/protocol";

/** The kind of membership site the deployment's members sign in with, and what pages call it, as the app loaded it: Memberful until it's known. */
export const MembershipProviderContext = createContext<MembershipProvider>({ kind: "memberful", name: "Memberful" });

export const useMembershipProvider = () => useContext(MembershipProviderContext);
