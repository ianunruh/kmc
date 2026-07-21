import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from "@mantine/core";
import { Notifications } from "@mantine/notifications";

import type { Route } from "./+types/root";
import { theme } from "./theme";
import { AppChrome } from "./shell/app-chrome";
import { listClusters } from "./vms/vms.server";
import { RefreshProvider } from "./lib/refresh";
import type { ClusterInfo } from "./lib/types";
import { authMiddleware, getRequestSession } from "./lib/auth/middleware.server";
import { getAuthMode } from "./lib/auth/mode.server";
import { isPublicPath } from "./lib/auth/paths.server";
import type { AuthMode, SessionUser } from "./lib/auth/types";

import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import "@fontsource/geist-mono/700.css";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./app.css";

export const links: Route.LinksFunction = () => [];

export const middleware: Route.MiddlewareFunction[] = [
  authMiddleware as Route.MiddlewareFunction,
];

export type RootLoaderData = {
  clusters: ClusterInfo[];
  authMode: AuthMode;
  user: SessionUser | null;
};

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const publicAuth = isPublicPath(url.pathname);

  const session = getRequestSession();
  const user = session?.user ?? null;

  if (publicAuth) {
    return {
      clusters: [] as ClusterInfo[],
      authMode: getAuthMode(),
      user,
    } satisfies RootLoaderData;
  }

  try {
    const clusters = await listClusters();
    return {
      clusters,
      authMode: getAuthMode(),
      user,
    } satisfies RootLoaderData;
  } catch {
    return {
      clusters: [] as ClusterInfo[],
      authMode: getAuthMode(),
      user,
    } satisfies RootLoaderData;
  }
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" {...mantineHtmlProps} data-mantine-color-scheme="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <ColorSchemeScript forceColorScheme="dark" defaultColorScheme="dark" />
        <Meta />
        <Links />
      </head>
      <body>
        <MantineProvider theme={theme} forceColorScheme="dark" defaultColorScheme="dark">
          <Notifications position="top-right" />
          {children}
        </MantineProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const data = useRouteLoaderData("root") as RootLoaderData | undefined;

  return (
    <RefreshProvider>
      <AppChrome
        clusters={data?.clusters ?? []}
        authMode={data?.authMode ?? "kubeconfig"}
        user={data?.user ?? null}
      >
        <Outlet />
      </AppChrome>
    </RefreshProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main style={{ padding: 24, fontFamily: "Geist Mono, monospace" }}>
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre style={{ overflow: "auto", padding: 16 }}>
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
