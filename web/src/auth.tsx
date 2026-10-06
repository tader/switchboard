import { createContext, useContext } from 'react';
import type { Info, User } from './api';

export interface Session {
  user: User;
  info: Info;
  setUser: (u: User | null) => void;
}

export const SessionCtx = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(SessionCtx);
