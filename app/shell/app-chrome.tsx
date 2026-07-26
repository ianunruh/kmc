import {
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Group,
  Menu,
  NavLink,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconDatabase,
  IconCpu,
  IconFolder,
  IconKey,
  IconLogout,
  IconNetwork,
  IconPhoto,
  IconPlus,
  IconRoute,
  IconRouter,
  IconServer,
  IconTopologyStar3,
  IconUser,
  IconArrowsRightLeft,
  IconWorldWww,
  IconCloudComputing,
  IconStack2,
} from "@tabler/icons-react";
import { Form, Link, useLocation } from "react-router";
import type { ReactNode } from "react";
import type { ClusterInfo } from "~/lib/types";
import type { AuthMode, SessionUser } from "~/lib/auth/types";
import { ClusterHealth } from "./cluster-health";
import { RefreshControl } from "./refresh-control";
import { TopLoadingBar } from "./top-loading-bar";

type NavItem = {
  to: string;
  label: string;
  icon: typeof IconServer;
  match: (path: string) => boolean;
};

type NavSection = {
  label: string;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    label: "Compute",
    items: [
      {
        to: "/",
        label: "Virtual Machines",
        icon: IconServer,
        match: (path: string) => path === "/" || path.startsWith("/vms"),
      },
      {
        to: "/datavolumes",
        label: "Data Volumes",
        icon: IconDatabase,
        match: (path: string) => path.startsWith("/datavolumes"),
      },
      {
        to: "/images",
        label: "Images",
        icon: IconPhoto,
        match: (path: string) => path.startsWith("/images"),
      },
      {
        to: "/ssh-keys",
        label: "SSH Keys",
        icon: IconKey,
        match: (path: string) => path.startsWith("/ssh-keys"),
      },
    ],
  },
  {
    label: "Data",
    items: [
      {
        to: "/databases",
        label: "Databases",
        icon: IconStack2,
        match: (path: string) => path.startsWith("/databases"),
      },
    ],
  },
  {
    label: "Network",
    items: [
      {
        to: "/ingresses",
        label: "Ingresses",
        icon: IconRoute,
        match: (path: string) => path.startsWith("/ingresses"),
      },
      {
        to: "/load-balancers",
        label: "Load Balancers",
        icon: IconCloudComputing,
        match: (path: string) => path.startsWith("/load-balancers"),
      },
      {
        to: "/topology",
        label: "Network Map",
        icon: IconTopologyStar3,
        match: (path: string) => path.startsWith("/topology"),
      },
    ],
  },
  {
    label: "VPC",
    items: [
      {
        to: "/vpcs",
        label: "VPCs",
        icon: IconNetwork,
        match: (path: string) => path.startsWith("/vpcs"),
      },
      {
        to: "/routers",
        label: "Routers",
        icon: IconRouter,
        match: (path: string) => path.startsWith("/routers"),
      },
      {
        to: "/floating-ips",
        label: "Floating IPs",
        icon: IconWorldWww,
        match: (path: string) => path.startsWith("/floating-ips"),
      },
      {
        to: "/port-forwards",
        label: "Port Forwards",
        icon: IconArrowsRightLeft,
        match: (path: string) => path.startsWith("/port-forwards"),
      },
    ],
  },
  {
    label: "Admin",
    items: [
      {
        to: "/namespaces",
        label: "Namespaces",
        icon: IconFolder,
        match: (path: string) => path.startsWith("/namespaces"),
      },
      {
        to: "/instancetypes",
        label: "Instance Types",
        icon: IconCpu,
        match: (path: string) => path.startsWith("/instancetypes"),
      },
    ],
  },
];

export function AppChrome({
  children,
  clusters = [],
  authMode = "kubeconfig",
  user = null,
}: {
  children: ReactNode;
  clusters?: ClusterInfo[];
  authMode?: AuthMode;
  user?: SessionUser | null;
}) {
  const [opened, { toggle }] = useDisclosure();
  const location = useLocation();
  const isLogin =
    location.pathname === "/login" || location.pathname.startsWith("/auth/");

  if (isLogin) {
    return (
      <>
        <TopLoadingBar />
        <Box mih="100vh" bg="#0b0d0f" p="md">
          {children}
        </Box>
      </>
    );
  }

  return (
    <AppShell
      header={{ height: 52 }}
      navbar={{
        width: 220,
        breakpoint: "sm",
        collapsed: { mobile: !opened },
      }}
      padding="md"
      styles={{
        main: { background: "#0b0d0f" },
        header: {
          background: "#12151a",
          borderBottom: "1px solid #1e242c",
        },
        navbar: {
          background: "#12151a",
          borderRight: "1px solid #1e242c",
        },
      }}
    >
      <TopLoadingBar />
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <UnstyledButton component={Link} to="/">
              <Group gap={8}>
                <Text fw={700} size="sm" tt="lowercase" c="accent.4">
                  kmc
                </Text>
                <Text size="xs" c="dimmed" visibleFrom="sm">
                  kcloud management console
                </Text>
              </Group>
            </UnstyledButton>
          </Group>
          <Group gap="md" wrap="nowrap">
            <ClusterHealth clusters={clusters} />
            <RefreshControl />
            {authMode === "kubeconfig" && (
              <Badge size="xs" variant="outline" color="gray">
                kubeconfig
              </Badge>
            )}
            {user ? (
              <Menu shadow="md" width={220} position="bottom-end">
                <Menu.Target>
                  <UnstyledButton>
                    <Group gap={6} wrap="nowrap">
                      <IconUser size={14} />
                      <Text size="xs" visibleFrom="sm" lineClamp={1} maw={140}>
                        {user.email}
                      </Text>
                    </Group>
                  </UnstyledButton>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>{user.githubLogin}</Menu.Label>
                  <Menu.Item
                    component={Link}
                    to="/me"
                    leftSection={<IconUser size={14} />}
                  >
                    Identity
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item
                    color="red"
                    leftSection={<IconLogout size={14} />}
                    component="button"
                    type="submit"
                    form="kmc-logout"
                  >
                    Sign out
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            ) : authMode === "impersonate" ? (
              <Button component={Link} to="/login" size="xs" variant="light">
                Sign in
              </Button>
            ) : (
              <Button component={Link} to="/login" size="xs" variant="subtle">
                Sign in
              </Button>
            )}
          </Group>
        </Group>
      </AppShell.Header>

      <Form id="kmc-logout" method="post" action="/auth/logout" />

      <AppShell.Navbar p="sm">
        {NAV_SECTIONS.map((section) => (
          <Box key={section.label} mb="sm">
            <Text size="xs" fw={600} c="dimmed" tt="uppercase" lts={0.5} px="sm" mb={4}>
              {section.label}
            </Text>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                component={Link}
                to={item.to}
                label={item.label}
                leftSection={<item.icon size={16} />}
                active={item.match(location.pathname)}
                variant="filled"
                mb={4}
              />
            ))}
          </Box>
        ))}
        <NavLink
          component={Link}
          to="/vms/create"
          label="Launch VM"
          leftSection={<IconPlus size={16} />}
          active={location.pathname === "/vms/create"}
          variant="subtle"
          mt="xs"
        />
        <Box mt="auto" p="xs">
          <Text size="xs" c="dimmed">
            {authMode === "impersonate" ? "impersonate mode" : "localhost console"}
          </Text>
        </Box>
      </AppShell.Navbar>

      <AppShell.Main className="kmc-shell-main">{children}</AppShell.Main>
    </AppShell>
  );
}
