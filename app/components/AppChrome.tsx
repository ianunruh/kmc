import {
  AppShell,
  Box,
  Burger,
  Group,
  NavLink,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconPlus, IconServer } from "@tabler/icons-react";
import { Link, useLocation } from "react-router";
import type { ReactNode } from "react";
import type { ClusterInfo } from "~/lib/types";
import { ClusterHealth } from "./ClusterHealth";
import { RefreshControl } from "./RefreshControl";
import { TopLoadingBar } from "./TopLoadingBar";

export function AppChrome({
  children,
  clusters = [],
}: {
  children: ReactNode;
  clusters?: ClusterInfo[];
}) {
  const [opened, { toggle }] = useDisclosure();
  const location = useLocation();

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
                  multi-cluster kubevirt
                </Text>
              </Group>
            </UnstyledButton>
          </Group>
          <Group gap="md" wrap="nowrap">
            <ClusterHealth clusters={clusters} />
            <RefreshControl />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <NavLink
          component={Link}
          to="/"
          label="Virtual Machines"
          leftSection={<IconServer size={16} />}
          active={location.pathname === "/"}
          variant="filled"
        />
        <NavLink
          component={Link}
          to="/vms/create"
          label="Create VM"
          leftSection={<IconPlus size={16} />}
          active={location.pathname.startsWith("/vms/create")}
          variant="filled"
          mt={4}
        />
        <Box mt="auto" p="xs">
          <Text size="xs" c="dimmed">
            localhost console
          </Text>
        </Box>
      </AppShell.Navbar>

      <AppShell.Main className="kmc-shell-main">{children}</AppShell.Main>
    </AppShell>
  );
}
