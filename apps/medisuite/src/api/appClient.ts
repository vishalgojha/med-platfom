import { supabase } from './supabaseClient';

type Json = Record<string, any>;

const AUTH_REQUIRED = String(import.meta.env.VITE_REQUIRE_AUTH ?? 'false').trim().toLowerCase() === 'true';
const SUPABASE_URL = ((import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '').trim();
const SUPABASE_ANON_KEY = ((import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '').trim();
const LOGIN_URL = ((import.meta.env.VITE_APP_LOGIN_URL as string | undefined) ?? '').trim();

const hasPlaceholderSupabaseConfig =
  SUPABASE_URL.length === 0 ||
  SUPABASE_URL.includes('example.supabase.co') ||
  SUPABASE_ANON_KEY.length === 0 ||
  SUPABASE_ANON_KEY === 'public-anon-key';

const AUTH_ENABLED = AUTH_REQUIRED && !hasPlaceholderSupabaseConfig;
const GUEST_USER = { id: 'guest', email: 'guest@local', role: 'guest' };

const toSnakeCase = (value: string): string => value.replace(/([A-Z])/g, '_$1').toLowerCase();

const parseSort = (sort?: string | null): { field: string; ascending: boolean } | null => {
  if (!sort || typeof sort !== 'string') {
    return null;
  }
  const ascending = !sort.startsWith('-');
  const field = sort.replace(/^-/, '');
  if (!field) {
    return null;
  }
  return { field, ascending };
};

const parseListArgs = (arg1?: any, arg2?: any): { sort?: string; limit?: number } => {
  if (typeof arg1 === 'string') {
    return { sort: arg1, limit: typeof arg2 === 'number' ? arg2 : undefined };
  }
  if (typeof arg1 === 'number') {
    return { limit: arg1 };
  }
  if (arg1 && typeof arg1 === 'object') {
    const sort = typeof arg1.sort === 'string' ? arg1.sort : undefined;
    const limit = typeof arg1.limit === 'number' ? arg1.limit : undefined;
    return { sort, limit };
  }
  return {};
};

const parseFilterArgs = (filter: Json = {}, arg2?: any, arg3?: any): { filter: Json; sort?: string; limit?: number } => {
  if (typeof arg2 === 'string') {
    return { filter, sort: arg2, limit: typeof arg3 === 'number' ? arg3 : undefined };
  }
  if (typeof arg2 === 'number') {
    return { filter, limit: arg2 };
  }
  if (arg2 && typeof arg2 === 'object') {
    const sort = typeof arg2.sort === 'string' ? arg2.sort : undefined;
    const limit = typeof arg2.limit === 'number' ? arg2.limit : undefined;
    return { filter, sort, limit };
  }
  return { filter };
};

const applyQuery = (query: any, sort?: string, limit?: number) => {
  let output = query;
  const parsed = parseSort(sort);
  if (parsed) {
    output = output.order(parsed.field, { ascending: parsed.ascending });
  }
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    output = output.limit(limit);
  }
  return output;
};

const safe = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    console.warn('appClient operation failed', error);
    return fallback;
  }
};

const createEntityClient = (entityName: string) => {
  const table = toSnakeCase(entityName);

  return {
    list: async (arg1?: any, arg2?: any): Promise<any[]> => {
      const { sort, limit } = parseListArgs(arg1, arg2);
      return safe(async () => {
        let query = supabase.from(table).select('*');
        query = applyQuery(query, sort, limit);
        const { data, error } = await query;
        if (error) {
          throw error;
        }
        return data ?? [];
      }, []);
    },

    filter: async (criteria: Json = {}, arg2?: any, arg3?: any): Promise<any[]> => {
      const { filter, sort, limit } = parseFilterArgs(criteria, arg2, arg3);
      return safe(async () => {
        let query = supabase.from(table).select('*');
        for (const [key, value] of Object.entries(filter ?? {})) {
          query = query.eq(key, value as any);
        }
        query = applyQuery(query, sort, limit);
        const { data, error } = await query;
        if (error) {
          throw error;
        }
        return data ?? [];
      }, []);
    },

    create: async (payload: Json): Promise<any> => {
      return safe(async () => {
        const { data, error } = await supabase.from(table).insert(payload).select().maybeSingle();
        if (error) {
          throw error;
        }
        return data ?? payload;
      }, payload ?? {});
    },

    bulkCreate: async (payload: Json[]): Promise<any[]> => {
      return safe(async () => {
        const { data, error } = await supabase.from(table).insert(payload).select();
        if (error) {
          throw error;
        }
        return data ?? payload;
      }, payload ?? []);
    },

    update: async (id: string, payload: Json): Promise<any> => {
      return safe(async () => {
        const { data, error } = await supabase.from(table).update(payload).eq('id', id).select().maybeSingle();
        if (error) {
          throw error;
        }
        return data ?? { id, ...payload };
      }, { id, ...(payload ?? {}) });
    },

    delete: async (id: string): Promise<{ id: string; deleted: boolean }> => {
      return safe(async () => {
        const { error } = await supabase.from(table).delete().eq('id', id);
        if (error) {
          throw error;
        }
        return { id, deleted: true };
      }, { id, deleted: false });
    },
  };
};

const entityProxy = new Proxy<Record<string, any>>(
  {},
  {
    get: (_, entityName: string) => createEntityClient(entityName),
  },
);

const invokeSupabaseFunction = async (name: string, payload: Json = {}): Promise<any> => {
  return safe(async () => {
    const { data, error } = await supabase.functions.invoke(name, { body: payload });
    if (error) {
      throw error;
    }
    return data ?? {};
  }, {});
};

const appAuth = {
  me: async (): Promise<any> => {
    if (!AUTH_ENABLED) {
      return GUEST_USER;
    }
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw error ?? new Error('Unauthenticated');
    }
    return data.user;
  },

  isAuthenticated: async (): Promise<boolean> => {
    if (!AUTH_ENABLED) {
      return true;
    }
    const { data } = await supabase.auth.getUser();
    return Boolean(data.user);
  },

  updateMe: async (payload: Json): Promise<any> => {
    if (!AUTH_ENABLED) {
      return { ...GUEST_USER, ...payload };
    }
    const { data, error } = await supabase.auth.updateUser({ data: payload });
    if (error) {
      throw error;
    }
    return data.user;
  },

  logout: async (redirectTo?: string): Promise<void> => {
    if (!AUTH_ENABLED) {
      return;
    }
    await supabase.auth.signOut();
    if (redirectTo && typeof window !== 'undefined') {
      window.location.href = redirectTo;
    }
  },

  redirectToLogin: (redirectTo?: string): void => {
    if (!AUTH_ENABLED) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    if (redirectTo) {
      window.sessionStorage.setItem('post_login_redirect', redirectTo);
    }
    if (!LOGIN_URL || LOGIN_URL === '/login') {
      console.warn('Auth is enabled but VITE_APP_LOGIN_URL is not configured to a valid login route.');
      return;
    }
    window.location.href = LOGIN_URL;
  },
};

const appIntegrations = {
  Core: {
    InvokeLLM: async (payload: Json): Promise<any> => {
      const response = await invokeSupabaseFunction('invoke-llm', payload);
      if (response && Object.keys(response).length > 0) {
        return response;
      }
      return { text: 'LLM integration is not configured yet.', payload };
    },

    SendEmail: async (payload: Json): Promise<any> => ({ ok: true, dryRun: true, payload }),
    SendSMS: async (payload: Json): Promise<any> => ({ ok: true, dryRun: true, payload }),
    UploadFile: async (payload: Json): Promise<any> => {
      const file = payload?.file;
      const fileUrl = file instanceof File ? URL.createObjectURL(file) : payload?.file_url;
      return { file_url: fileUrl ?? '' };
    },

    GenerateImage: async (payload: Json): Promise<any> => ({ image_url: '', payload }),
    ExtractDataFromUploadedFile: async (payload: Json): Promise<any> => ({ extracted: null, payload }),
  },
};

const appFunctions = {
  invoke: async (name: string, payload: Json = {}): Promise<any> => invokeSupabaseFunction(name, payload),
};

const appAgents = {
  getWhatsAppConnectURL: (agentName: string): string => {
    const baseUrl = (import.meta.env.VITE_APP_WHATSAPP_BASE_URL as string | undefined) ?? 'https://wa.me';
    const text = encodeURIComponent(`Connect me with ${agentName}`);
    return `${baseUrl}/?text=${text}`;
  },

  createConversation: async (payload: Json = {}): Promise<any> => ({
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
    ...payload,
  }),

  subscribeToConversation: (_conversationId: string, _listener: (data: any) => void): (() => void) => {
    return () => {};
  },

  addMessage: async (conversation: Json, message: Json): Promise<any> => ({
    conversation,
    message,
    created_at: new Date().toISOString(),
  }),

  listConversations: async (_filters: Json = {}): Promise<any[]> => [],
};

const appLogs = {
  logUserInApp: async (pageName: string): Promise<void> => {
    console.debug('app.logUserInApp', { pageName });
  },
};

export const appClient: any = {
  auth: appAuth,
  entities: entityProxy,
  integrations: appIntegrations,
  functions: appFunctions,
  agents: appAgents,
  appLogs,
};
