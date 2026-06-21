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
  SidebarHeader,
  SidebarFooter,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { LayoutDashboard, TrendingUp, Database, Globe, Brain, Menu } from "lucide-react";
import React from "react";
import { UserMenu } from "@/components/auth/user-menu";
const basePath = import.meta.env.BASE_URL;

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <SidebarProvider defaultOpen>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar className="border-r border-border/40 bg-[#0c0e14]">
          <SidebarHeader className="p-4 border-b border-border/40">
            <div className="flex items-center gap-2.5 px-2">
              <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Globe className="h-5 w-5 text-primary" />
              </div>
              <span className="font-bold text-base tracking-tight" style={{ fontFamily: "'Inter', sans-serif" }}>Intel<span className="text-muted-foreground font-medium">Dash</span></span>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.12em] px-2 py-3">Navigation</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/dashboard" || location === "/"} className="data-[active=true]:bg-primary/10 data-[active=true]:text-primary data-[active=true]:border-l-2 data-[active=true]:border-primary rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all">
                      <Link href={`${basePath}dashboard`}>
                        <LayoutDashboard className="h-4 w-4" />
                        <span>Terminal</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/trending"} className="data-[active=true]:bg-primary/10 data-[active=true]:text-primary data-[active=true]:border-l-2 data-[active=true]:border-primary rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all">
                      <Link href={`${basePath}trending`}>
                        <TrendingUp className="h-4 w-4" />
                        <span>Trending Vectors</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/sources"} className="data-[active=true]:bg-primary/10 data-[active=true]:text-primary data-[active=true]:border-l-2 data-[active=true]:border-primary rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all">
                      <Link href={`${basePath}sources`}>
                        <Database className="h-4 w-4" />
                        <span>Data Sources</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild isActive={location === "/intelligence"} className="data-[active=true]:bg-primary/10 data-[active=true]:text-primary data-[active=true]:border-l-2 data-[active=true]:border-primary rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all">
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
          <SidebarFooter className="p-3 border-t border-border/40">
            <UserMenu />
          </SidebarFooter>
        </Sidebar>
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center gap-3 border-b border-border/40 bg-[#0c0e14] px-4 py-3 md:hidden">
            <SidebarTrigger className="h-9 w-9 shrink-0">
              <Menu className="h-5 w-5" />
              <span className="sr-only">Toggle menu</span>
            </SidebarTrigger>
            <span className="font-bold text-sm tracking-tight" style={{ fontFamily: "'Inter', sans-serif" }}>Intel<span className="text-muted-foreground font-medium">Dash</span></span>
          </div>
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
