import { applyTheme, watchSystemTheme, useThemePreference } from "./theme";
import {
  StrictMode,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  ChatProvider,
  defaultLabels,
  type ChatTranslate,
} from "@olorinm/agent-ui";
import { ConfirmProvider, ToastProvider } from "@olorinm/agent-ui/app";
import { FrontendProvider } from "@olorinm/agent-frontend";
import "@olorinm/agent-frontend/style.css";
import "./styles.css";
import { ApiError } from "./api/http";
import { App } from "./app";
import {
  dictionaries,
  I18n,
  initialLanguage,
  saveLanguage,
  translator,
  type Language,
  type MessageKey,
} from "./i18n";

function Root() {
  useEffect(watchSystemTheme, []);
  const [theme] = useThemePreference();
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  const t = useMemo(() => translator(language), [language]);
  const i18n = useMemo(
    () => ({
      language,
      t,
      setLanguage(next: Language) {
        saveLanguage(next);
        setLanguageState(next);
      },
    }),
    [language, t],
  );
  // Shared components use Mau copy where it exists and their own English defaults otherwise.
  const translate = useCallback<ChatTranslate>(
    (key, values) =>
      key in dictionaries[language]
        ? t(key as MessageKey, values)
        : defaultLabels[key].replace(/\{(\w+)\}/g, (token, name: string) =>
            String(values?.[name] ?? token),
          ),
    [language, t],
  );
  const expired = useRef<() => void>(() => {});
  const [client] = useState(() => {
    const unauthorized = (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) expired.current();
    };
    return new QueryClient({
      queryCache: new QueryCache({ onError: unauthorized }),
      mutationCache: new MutationCache({ onError: unauthorized }),
      defaultOptions: {
        queries: {
          // Client errors are answers, not transient failures.
          retry: (count, error) =>
            !(
              error instanceof ApiError &&
              error.status >= 400 &&
              error.status < 500
            ) && count < 2,
        },
      },
    });
  });
  return (
    <I18n.Provider value={i18n}>
      <ChatProvider translate={translate}>
        <QueryClientProvider client={client}>
          <FrontendProvider language={language} theme={theme}>
            <ConfirmProvider>
              <ToastProvider>
                <App
                  onExpired={(handler) => {
                    expired.current = handler;
                  }}
                />
              </ToastProvider>
            </ConfirmProvider>
          </FrontendProvider>
        </QueryClientProvider>
      </ChatProvider>
    </I18n.Provider>
  );
}

document.documentElement.lang = initialLanguage();
applyTheme();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
