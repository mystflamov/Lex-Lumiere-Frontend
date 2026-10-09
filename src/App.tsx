import './App.css'
import { useEffect, useState, lazy, Suspense } from 'react'
import type { Route } from '@/lib/types'
import { NavProvider, useNav } from '@/lib/nav'
import { PortalProvider, usePortal } from '@/lib/store'
import { AdminGrowthSummaryProvider } from '@/lib/admin-growth-summary'
import { AuthProvider, useAuth } from '@/lib/auth'
import { LogoutModal } from '@/components/LogoutModal'
import { OfflineBanner } from '@/components/OfflineBanner'
import { LoadingSkeleton } from '@/components/LoadingSkeleton'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { loadRosterFromDatabase } from '@/lib/roster'
import { PlannerProvider } from '@/lib/planner'
import { WarehouseProvider } from '@/lib/warehouse'
import { GroundCrewLoginPage } from '@/pages/GroundCrewLoginPage'

// Code-split page components for minimal initial bundle latency
const LoginPage = lazy(() => import('@/pages/LoginPage').then((m) => ({ default: m.LoginPage })))
const OverviewPage = lazy(() => import('@/pages/OverviewPage').then((m) => ({ default: m.OverviewPage })))
const AdminSystemDashboardPage = lazy(() => import('@/pages/AdminSystemDashboardPage').then((m) => ({ default: m.AdminSystemDashboardPage })))
const AdminWorkforcePage = lazy(() => import('@/pages/AdminWorkforcePage').then((m) => ({ default: m.AdminWorkforcePage })))
const WarehouseHomePage = lazy(() => import('@/pages/WarehouseHomePage').then((m) => ({ default: m.WarehouseHomePage })))
const WarehouseModulePage = lazy(() => import('@/pages/WarehouseModulePage').then((m) => ({ default: m.WarehouseModulePage })))
const GroundCrewPage = lazy(() => import('@/pages/GroundCrewPage').then((m) => ({ default: m.GroundCrewPage })))
const PinSetupScreen = lazy(() => import('@/pages/PinSetupScreen').then((m) => ({ default: m.PinSetupScreen })))
const TempPasswordResetScreen = lazy(() => import('@/pages/TempPasswordResetScreen').then((m) => ({ default: m.TempPasswordResetScreen })))

// Code-split heavy subpages for feature-level chunking
const AdminSecurityAuditPage = lazy(() => import('@/pages/AdminSecurityAuditPage').then((m) => ({ default: m.AdminSecurityAuditPage })))
const AdminRolesPage = lazy(() => import('@/pages/AdminRolesPage').then((m) => ({ default: m.AdminRolesPage })))
const EventDashboardPage = lazy(() => import('@/pages/EventDashboardPage').then((m) => ({ default: m.EventDashboardPage })))
const EventRegistryPage = lazy(() => import('@/pages/EventRegistryPage').then((m) => ({ default: m.EventRegistryPage })))
const ReplenishmentPage = lazy(() => import('@/pages/ReplenishmentPage').then((m) => ({ default: m.ReplenishmentPage })))
const ActivityLogsPage = lazy(() => import('@/pages/ActivityLogsPage').then((m) => ({ default: m.ActivityLogsPage })))
const DamageValidationPage = lazy(() => import('@/pages/DamageValidationPage').then((m) => ({ default: m.DamageValidationPage })))
const InventoryStockPage = lazy(() => import('@/pages/InventoryStockPage').then((m) => ({ default: m.InventoryStockPage })))
const PlannerAssetCatalogPage = lazy(() => import('@/pages/PlannerAssetCatalogPage').then((m) => ({ default: m.PlannerAssetCatalogPage })))
const WarehouseLogsPage = lazy(() => import('@/pages/WarehouseLogsPage').then((m) => ({ default: m.WarehouseLogsPage })))
const CrewRosterPage = lazy(() => import('@/pages/CrewRosterPage').then((m) => ({ default: m.CrewRosterPage })))
const TaskDeploymentsPage = lazy(() => import('@/pages/TaskDeploymentsPage').then((m) => ({ default: m.TaskDeploymentsPage })))
const DispatchManifestPage = lazy(() => import('@/pages/DispatchManifestPage').then((m) => ({ default: m.DispatchManifestPage })))
const EventDetailPage = lazy(() => import('@/pages/EventDetailPage').then((m) => ({ default: m.EventDetailPage })))
const DesignCanvasHubPage = lazy(() => import('@/pages/DesignCanvasHubPage').then((m) => ({ default: m.DesignCanvasHubPage })))
const CanvasWorkspacePage = lazy(() => import('@/pages/CanvasWorkspacePage').then((m) => ({ default: m.CanvasWorkspacePage })))
const WarehouseLeadPage = lazy(() => import('@/pages/WarehouseLeadPage').then((m) => ({ default: m.WarehouseLeadPage })))
const WarehouseMemberPage = lazy(() => import('@/pages/WarehouseMemberPage').then((m) => ({ default: m.WarehouseMemberPage })))
const ManningPage = lazy(() => import('@/pages/ManningPage').then((m) => ({ default: m.ManningPage })))
const ProductionManagerPage = lazy(() => import('@/pages/ProductionManagerPage').then((m) => ({ default: m.ProductionManagerPage })))
const InventoryOfficerPage = lazy(() => import('@/pages/InventoryOfficerPage').then((m) => ({ default: m.InventoryOfficerPage })))
const ProjectManagerDashboardPage = lazy(() => import('@/pages/ProjectManagerDashboardPage').then((m) => ({ default: m.ProjectManagerDashboardPage })))
const ExecutiveAssetInventoryPage = lazy(() => import('@/pages/ExecutiveAssetInventoryPage').then((m) => ({ default: m.ExecutiveAssetInventoryPage })))
const VendorManagementPage = lazy(() => import('@/pages/VendorManagementPage').then((m) => ({ default: m.VendorManagementPage })))
const WarehouseDrilldown = lazy(() => import('@/components/warehouse/WarehouseDrilldown').then((m) => ({ default: m.WarehouseDrilldown })))
import type { WarehouseModuleId } from '@/lib/warehouse-modules'
import { canAccessRoute, getDefaultRouteForUser, PWA_STANDALONE_ROUTES } from '@/lib/route-guard'

function UnauthorizedRedirect({ canonicalRoute }: { canonicalRoute: Route }) {
  const { navigate } = useNav()
  useEffect(() => {
    navigate(canonicalRoute, null, { replace: true })
  }, [canonicalRoute, navigate])
  return null
}

function PortalAccessError({ portal }: { portal: 'web' | 'pwa' }) {
  const { logout } = useAuth()
  const isPwa = portal === 'pwa'
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
      <section className="paper-card w-full max-w-md text-center">
        <p className="eyebrow">Access boundary</p>
        <h1 className="mt-2 font-serif text-3xl">Wrong portal</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          This account is registered for the {isPwa ? 'Lumière PWA' : 'Lumière web app'}. The {isPwa ? 'web app' : 'PWA'} cannot be opened with this account.
        </p>
        <button type="button" className="button-primary mt-6 w-full" onClick={logout}>Return to login</button>
      </section>
    </main>
  )
}

function Router() {
  const { route, navigate } = useNav()
  const {
    currentUser,
    portal,
    isWarehouse,
    isAdmin,
    isExecutive,
    isExecutiveLite,
    isProjectManager,
    isProjectManagerLite,
    isWarehouseAssociate,
    isProductionManager,
    isInventoryOfficer,
    hasFullWarehouseAccess,
    canAccessAssetInventory,
  } = useAuth()
  // The Production Manager WOM sub-role gets its own mobile PWA page (matching
  // the Ground Crew / Warehouse Lead / Warehouse Member mobile accounts)
  // instead of the desktop sidebar shell — but only when scoped to that single
  // sub-role. The full-access Warehouse Ops Manager super-account still uses
  // the desktop WarehouseHomePage even if its subRole happens to be unset.
  const isMobileProductionManager = isProductionManager && !hasFullWarehouseAccess
  const isMobileInventoryOfficer = isInventoryOfficer && !hasFullWarehouseAccess
  const isPwaRoute = PWA_STANDALONE_ROUTES.has(route)
  if (portal && ((portal === 'pwa') !== isPwaRoute)) return <PortalAccessError portal={portal} />

  // Centralized route authorization check: block unauthorized components before mounting
  const isAllowed = canAccessRoute(currentUser, route, canAccessAssetInventory)
  if (!isAllowed) {
    const canonical = getDefaultRouteForUser(currentUser)
    if (typeof window !== 'undefined' && window.location.pathname !== `/${canonical}`) {
      window.history.replaceState({ route: canonical }, '', `/${canonical}`)
    }
    return <UnauthorizedRedirect canonicalRoute={canonical} />
  }

  // Client-side scoped role guard for Executive Lite:
  // Allowed client routes: dashboard, inventory (conditional), registry.
  // Fails closed to EventDashboardPage.
  if (isExecutiveLite) {
    switch (route) {
      case 'dashboard':
        return <EventDashboardPage />
      case 'inventory':
        return canAccessAssetInventory ? <ExecutiveAssetInventoryPage /> : <EventDashboardPage />
      case 'registry':
        return <EventRegistryPage />
      default:
        return <EventDashboardPage />
    }
  }

  // Client-side scoped role guard for Project Manager Lite:
  // PM Lite is restricted to event management and read-only event-scoped allocation visibility.
  // Explicitly denied: Canvas, Canvas Workspace, Manning, Production, Workforce, Admin governance.
  if (isProjectManagerLite) {
    switch (route) {
      case 'registry':
        return <EventRegistryPage />
      case 'event-detail':
        return <EventDetailPage />
      case 'project-manager':
      default:
        return <ProjectManagerDashboardPage />
    }
  }

  // Client-side scoped role guard for Warehouse Associate:
  // Allowed client routes: overview (dashboard), inventory (assets), replenishment, vendors, dispatch.
  // Explicitly denied: Manning, Production, Workforce, Logs, full WOM super-role admin.
  if (isWarehouseAssociate) {
    switch (route) {
      case 'vendors':
        return <VendorManagementPage />
      case 'inventory':
      case 'replenishment':
      case 'dispatch': {
        const modId = route === 'inventory' ? 'assets' : (route as WarehouseModuleId)
        return (
          <WarehouseDrilldown
            entry={{ kind: 'module', moduleId: modId }}
            onExit={() => navigate('overview')}
          />
        )
      }
      case 'overview':
      default:
        return <WarehouseHomePage />
    }
  }

  // Full Warehouse Operations accounts use one desktop shell for the dashboard
  // and every operational module. Scoped associate and mobile routes retain
  // their dedicated experiences above.
  if (isWarehouse && hasFullWarehouseAccess) {
    switch (route) {
      case 'inventory':
        return <WarehouseModulePage moduleId="assets" />
      case 'replenishment':
        return <WarehouseModulePage moduleId="replenishment" />
      case 'vendors':
        return <WarehouseModulePage moduleId="vendors" />
      case 'crew':
        return <WarehouseModulePage moduleId="manning" />
      case 'dispatch':
        return <WarehouseModulePage moduleId="dispatch" />
      case 'production':
        return <WarehouseModulePage moduleId="production" />
      case 'damage':
        return <DamageValidationPage />
      case 'overview':
      default:
        return <WarehouseHomePage />
    }
  }

  // Client-side role guard for Project Manager:
  // PM is restricted to project manager dashboard and design canvas oversight surfaces.
  // PM cannot mount Admin/Executive operational pages (security-audit, workforce, rbac, executive dashboard/logs).
  if (isProjectManager) {
    switch (route) {
      case 'canvas':
        return <DesignCanvasHubPage />
      case 'canvas-workspace':
        return <CanvasWorkspacePage />
      case 'project-manager':
      default:
        return <ProjectManagerDashboardPage />
    }
  }

  // Event Planner is intentionally isolated from registry and damage
  // operations. Dashboard / project / mood-board content is introduced in
  // later planner phases; for now these shell destinations land on the
  // existing planner workspace hub.
  if (currentUser?.role === 'Event Planner') {
    switch (route) {
      case 'inventory':
        return <PlannerAssetCatalogPage />
      case 'canvas-workspace':
        return <CanvasWorkspacePage />
      case 'event-detail':
        return <EventDetailPage />
      case 'dashboard':
      case 'design-projects':
      case 'mood-boards':
      case 'canvas':
      default:
        return <DesignCanvasHubPage />
    }
  }

  switch (route) {
    case 'dashboard':
      return <EventDashboardPage />
    case 'registry':
      return <EventRegistryPage />
    case 'replenishment':
      return <ReplenishmentPage />
    case 'logs':
      return <ActivityLogsPage />
    case 'damage':
      return <DamageValidationPage />
    case 'inventory':
      if (isExecutive) {
        return canAccessAssetInventory ? <ExecutiveAssetInventoryPage /> : <EventDashboardPage />
      }
      return <InventoryStockPage />
    case 'warehouse-logs':
      return <WarehouseLogsPage />
    case 'crew':
      return <CrewRosterPage />
    case 'deployments':
      return <TaskDeploymentsPage />
    case 'dispatch':
      return <DispatchManifestPage />
    case 'vendors':
      return <VendorManagementPage />
    case 'event-detail':
      return <EventDetailPage />
    case 'canvas':
      return <DesignCanvasHubPage />
    case 'canvas-workspace':
      return <CanvasWorkspacePage />
    case 'field-ops':
      return <GroundCrewPage />
    case 'warehouse-lead':
      return <WarehouseLeadPage />
    case 'warehouse-member':
      return <WarehouseMemberPage />
    case 'manning':
      return <ManningPage />
    case 'production-manager':
      return <ProductionManagerPage />
    case 'inventory-officer':
      return <InventoryOfficerPage />
    case 'project-manager':
      return <ProjectManagerDashboardPage />
    case 'workforce':
      return <AdminWorkforcePage />
    case 'security-audit':
      return <AdminSecurityAuditPage />
    case 'rbac':
      return <AdminRolesPage />
    case 'overview':
    default:
      // Role-aware home. Admins always land on the icon-rail System Dashboard —
      // never the legacy sidebar shell — even for unknown routes.
      return isAdmin ? (
        <AdminSystemDashboardPage />
      ) : isMobileProductionManager ? (
        <ProductionManagerPage />
      ) : isMobileInventoryOfficer ? (
        <InventoryOfficerPage />
      ) : isProjectManager ? (
        <ProjectManagerDashboardPage />
      ) : isWarehouse ? (
        <WarehouseHomePage />
      ) : (
        <OverviewPage />
      )
  }
}

function Gate() {
  const { staff: portalStaff, addUserAction } = usePortal()
  const {
    currentUser,
    isAuthenticated,
    isTempPassword,
    isAdmin,
    isExecutive,
    hasConfirmationPin,
    canAccessAssetInventory,
  } = useAuth()
  const [portal, setPortal] = useState<'staff' | 'crew'>('staff')

  if (!isAuthenticated || !currentUser) {
    return portal === 'crew' ? (
      <GroundCrewLoginPage onStaffPortal={() => setPortal('staff')} />
    ) : (
      <LoginPage
        onCrewPortal={() => setPortal('crew')}
        portalStaff={portalStaff}
        addUserAction={addUserAction}
      />
    )
  }

  if (isTempPassword) {
    return <TempPasswordResetScreen />
  }

  if (!isAdmin && !isExecutive && !hasConfirmationPin) {
    return <PinSetupScreen />
  }

  // A deep-linked ?highlight=<staffId> (from the User Growth Summary modal)
  // should land straight on Workforce Management on a fresh load/refresh —
  // scoped to this one param, not a general URL-routing migration.
  const rawPath = typeof window !== 'undefined' ? window.location.pathname.replace(/^\/+|\/+$/g, '') : ''
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const urlRouteParam = searchParams.get('route')
  const moduleParam = searchParams.get('module')?.toLowerCase().trim()
  let candidateRoute = (urlRouteParam || rawPath) as Route

  // Canonicalize legacy /overview?module=vendors directly to /vendors
  if (rawPath === 'overview' && moduleParam === 'vendors') {
    if (typeof window !== 'undefined') {
      window.history.replaceState({ route: 'vendors' }, '', '/vendors')
    }
    candidateRoute = 'vendors'
  }

  const hasWorkforceHighlight =
    typeof window !== 'undefined' &&
    (searchParams.has('highlight') || Boolean(window.history.state?.highlight))

  let initialRoute: Route
  if (hasWorkforceHighlight && canAccessRoute(currentUser, 'workforce', canAccessAssetInventory)) {
    initialRoute = 'workforce'
  } else if (candidateRoute && canAccessRoute(currentUser, candidateRoute, canAccessAssetInventory)) {
    initialRoute = candidateRoute
  } else {
    initialRoute = getDefaultRouteForUser(currentUser)
  }

  return (
    <NavProvider initialRoute={initialRoute}>
      <AdminGrowthSummaryProvider>
        <ErrorBoundary>
          <Suspense fallback={<LoadingSkeleton variant="page" />}>
            <Router />
          </Suspense>
        </ErrorBoundary>
      </AdminGrowthSummaryProvider>
    </NavProvider>
  )
}
function App() {
  useEffect(() => {
    // Load the crew roster from the database on app initialization
    loadRosterFromDatabase()
  }, [])

  return (
    <AuthProvider>
      <PortalProvider>
        <PlannerProvider>
          <WarehouseProvider>
            <OfflineBanner />
            <Gate />
            <LogoutModal />
          </WarehouseProvider>
        </PlannerProvider>
      </PortalProvider>
    </AuthProvider>
  )
}

export default App
