import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarHeader
} from "@/components/ui/sidebar";
import { LayoutDashboard, TrendingUp, Database, Globe, Brain } from "lucide-react";
const basePath = import.meta.env.BASE_URL;

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <SidebarProvider defaultOpen>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar className="border-r border-border bg-sidebar">
          <SidebarHeader className="p-4 border-b border-border">
            <div className="flex items-center gap-2 px-2 text-sidebar-primary">
              <Globe className="h-6 w-6" />
              <span className="font-bold text-lg tracking-tight uppercase">Intel<span className="text-muted-foreground font-medium">Dash</span></span>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Navigation</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/"}>
                      <Link href={`${basePath}`}>
                        <LayoutDashboard className="h-4 w-4" />
                        <span>Terminal</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/trending"}>
                      <Link href={`${basePath}trending`}>
                        <TrendingUp className="h-4 w-4" />
                        <span>Trending Vectors</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/sources"}>
                      <Link href={`${basePath}sources`}>
                        <Database className="h-4 w-4" />
                        <span>Data Sources</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/intelligence"}>
                      <Link href={`${basePath}intelligence`}>
                        <Brain className="h-4 w-4" />
                        <span>Intelligence</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <main className="flex-1 flex flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
