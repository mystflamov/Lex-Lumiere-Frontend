import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  AlertTriangle,
  Briefcase,
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Layers,
  Lock,
  MapPin,
  PackageCheck,
  Play,
  Send,
  ShieldCheck,
  UserCircle2,
  Clock,
  Edit3,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  History,
} from 'lucide-react'
import { useAuth } from '@/lib/auth'
import { usePortal } from '@/lib/store'
import {
  fetchMyManningAssignments,
  updateMyAssignmentExecutionStatus,
  type MyManningAssignmentDto,
} from '@/features/manning/api/manningApi'
import { useDispatchStore } from '@/lib/warehouse-dispatch'
import type { DispatchBatch } from '@/lib/event-detail'
import { PartialEgressSection } from '@/components/warehouse/PartialEgressSection'
import { ProductionHandoffCard } from '@/components/warehouse/production/ProductionHandoffCard'
import { useProductionItems } from '@/lib/warehouse-production'
import {
  decideGroundCrewDeclaration,
  getDeclarationAging,
  loadDeclarationsFromBackend,
  submitGroundCrewDeclaration,
  updateGroundCrewDeclaration,
  useGroundCrewDeclarations,
  type GroundCrewDeclaration,
} from '@/lib/ground-crew-declarations'
import { computePhotoSha256, extractPhotoMetadata, type HavaPhotoMetadata } from '@/lib/hava'
import { getPendingQueue, type QueuedDeclaration } from '@/lib/offlineQueue'
import { subscribeOfflineSync, triggerOfflineReplay } from '@/lib/offlineReplay'
import { queueManningStatusUpdate, getManningUserMutations } from '@/lib/offline/manningOutbox'
import { queueOfflinePhaseAdvancement } from '@/lib/offline/checklistOutbox'
import { triggerOutboxReplay, subscribeSyncEngine } from '@/lib/offline/offlineReplayEngine'
import { setReadCache, getReadCache } from '@/lib/offline/db'
import { StatusBadge } from '@/components/StatusBadge'
import { GroundCrewSyncPill } from '@/pages/GroundCrewSyncPill'
import {
  PwaBadge,
  PwaBottomNav,
  PwaButton,
  PwaCard,
  PwaEmptyState,
  PwaHeader,
  PwaModal,
  PwaToast,
  HavaCameraCaptureModal,
  type CapturedEvidence,
  type PwaNavItem,
} from '@/components/pwa'
import type { HavaDeclarationState, HavaEvidenceStatus } from '@/lib/types'

type Tab = 'home' | 'tasks' | 'history' | 'account'
type AccessLevel = 'Ground Crew / Member' | 'Team Lead / Field Lead' | 'Receiver' | 'Event Admin'
export type CheckpointPhase = 'Dispatch Loading' | 'Venue Arrival' | 'Pre-Event Setup' | 'Post-Event Egress'
type EventStatus = 'Current' | 'Upcoming' | 'Completed'
type RequestStatus = 'Pending' | 'Approved' | 'Denied'

interface EventItem {
  id: string
  name: string
  date: string
  venue: string
  status: EventStatus
  editable: boolean
  phase: CheckpointPhase | null  // null = no canonical dispatch phase assigned
  items: { id: string; name: string; sku: string; qty: number; color: string }[]
}
interface DamageReport {
  id: string
  event: string
  item: string
  phase: CheckpointPhase
  quantity: number
  description: string
  photo: string
  photoHash?: string
  capturedAt: string
  location: string
  sha256Hash?: string
  gpsCoordinates?: string
  condition?: 'Damaged' | 'Missing'
  declarationState?: HavaDeclarationState
  evidenceStatus?: HavaEvidenceStatus | string
  isTemporallyValid?: boolean
  reviewDeadlineAt?: string
  version?: number
  isEditable?: boolean
  offlineSyncStatus?: 'locally queued' | 'syncing' | 'server accepted' | 'server rejected/conflicted'
  lastError?: string
}
interface CrewRequest {
  id: string
  type: string
  date: string
  note: string
  status: RequestStatus
}

function dateLabel(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

const FIELD_STAGES = ['Venue Arrival', 'Warehouse Return'] as const

const HISTORY_DEMO_EVENTS = [
  { id: 'history-event-1', name: 'Empress Fine Jewelry Private Exhibition', venue: 'The Glasshouse, Makati', date: '2026-09-18' },
  { id: 'history-event-2', name: 'Lumière Garden Reception', venue: 'Ayala Museum', date: '2026-09-12' },
]
const HISTORY_DEMO_REPORTS = [
  { id: 'history-report-1', item: 'Ghost Chair', event: 'Empress Fine Jewelry Private Exhibition', capturedAt: '2026-09-18', status: 'Pending review' },
  { id: 'history-report-2', item: 'Warm Pin Light', event: 'Lumière Garden Reception', capturedAt: '2026-09-12', status: 'Reviewed' },
]

const FIELD_PREVIEW_EVENT: EventItem = {
  id: 'field-preview-event',
  name: 'Lumière Live Operational Demonstration',
  date: new Date().toISOString().slice(0, 10),
  venue: 'The Glasshouse, Makati',
  status: 'Current',
  editable: true,
  phase: 'Venue Arrival',
  items: [
    { id: 'field-preview-stage', name: 'Custom Modular Velvet Stage Platform 4×8', sku: 'STG-4X8', qty: 1, color: 'Onyx' },
    { id: 'field-preview-chairs', name: 'Ghost Chair', sku: 'CHR-GHOST', qty: 24, color: 'Clear' },
    { id: 'field-preview-lights', name: 'Warm Pin Light', sku: 'LGT-PIN-WARM', qty: 8, color: 'Warm white' },
    { id: 'field-preview-arch', name: 'Modular Arch Panel', sku: 'ARC-MOD-01', qty: 6, color: 'Ivory' },
  ],
}

type FieldStage = (typeof FIELD_STAGES)[number]
type FieldItemState = 'Not checked' | 'Verified' | 'Missing'

type CrewAssignmentScope = 'Warehouse' | 'Field'

function FieldConsole({ events, assignmentScope, isLeadForEvent }: { events: EventItem[]; assignmentScope: CrewAssignmentScope; isLeadForEvent: (eventId: string) => boolean }) {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [activeStage, setActiveStage] = useState<FieldStage | null>(null)
  const [checkedItems, setCheckedItems] = useState<Record<string, FieldItemState>>({})
  const [notes, setNotes] = useState('')
  const [confirmedStages, setConfirmedStages] = useState<Record<string, boolean>>({})
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? null
  const items = selectedEvent?.items ?? []
  const stageKey = selectedEvent && activeStage ? `${selectedEvent.id}:${activeStage}` : ''
  const completed = items.filter((item) => checkedItems[`${stageKey}:${item.id}`] && checkedItems[`${stageKey}:${item.id}`] !== 'Not checked').length
  const editableStages = new Set<FieldStage>(FIELD_STAGES)
  const isEditableStage = activeStage ? editableStages.has(activeStage) : false
  const canOpenStage = (eventId: string, index: number) => FIELD_STAGES.slice(0, index).every((stage) => !editableStages.has(stage) || confirmedStages[`${eventId}:${stage}`])
  const canConfirm = isEditableStage && isLeadForEvent(selectedEvent?.id ?? '') && items.length > 0 && completed === items.length

  if (activeStage && selectedEvent) {
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => setActiveStage(null)} className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground">← Back to stages</button>
        <PwaCard title={activeStage === 'Venue Arrival' ? 'Ingress · Venue Arrival' : 'Egress · Warehouse Return'} subtitle={`${selectedEvent.name} · ${selectedEvent.venue}`}>
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs"><span className="font-semibold">Asset manifest</span><span className="text-muted-foreground">{completed}/{items.length} verified</span></div>
            
            {items.length === 0 ? <PwaEmptyState title="Manifest not available" description="This event has no dispatch manifest yet." /> : <div className="space-y-2">{items.map((item) => { const key = `${stageKey}:${item.id}`; const status = checkedItems[key] ?? 'Not checked'; return <div key={item.id} className="flex items-center gap-3 rounded-xl border border-border p-3"><button type="button" disabled={!isEditableStage} aria-label={`Verify ${item.name}`} onClick={() => setCheckedItems((current) => ({ ...current, [key]: status === 'Verified' ? 'Not checked' : 'Verified' }))} className={`flex size-6 shrink-0 items-center justify-center rounded-md border disabled:opacity-50 ${status === 'Verified' ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>{status === 'Verified' && <Check className="size-4" />}</button><div className="min-w-0 flex-1"><p className="text-xs font-semibold">{item.name} <span className="font-normal text-muted-foreground">× {item.qty}</span></p><p className="text-[10px] text-muted-foreground">{status}</p></div><PwaBadge label={status} variant={status === 'Verified' ? 'subrole' : 'neutral'} /></div>})}</div>}
            {!isLeadForEvent(selectedEvent.id) && isEditableStage && <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">Only the Team Lead can complete this phase. You can still review the list and add notes.</div>}
            <label className="block text-xs font-semibold">Notes (optional)<textarea disabled={!isEditableStage} value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} className="mt-1 w-full rounded-xl border border-input bg-background p-3 text-xs disabled:opacity-60" placeholder="Add a note for the next crew..." /></label>
            <button type="button" disabled={!canConfirm} onClick={() => { setConfirmedStages((current) => ({ ...current, [stageKey]: true })); setActiveStage(null) }} className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">{isLeadForEvent(selectedEvent.id) ? `Confirm ${activeStage}` : 'Team Lead confirmation required'}</button>
          </div>
        </PwaCard>
      </div>
    )
  }

  return <div className="space-y-4"><PwaCard title="Field checklist" subtitle={`${assignmentScope} assignment · check each item before moving on.`}><p className="text-xs leading-relaxed text-muted-foreground">Work offline when needed. Your updates will sync when you reconnect.</p>{events.some((event) => event.id === FIELD_PREVIEW_EVENT.id) && <p className="mt-3 rounded-lg bg-primary/10 px-3 py-2 text-[10px] text-primary">Preview event data for crew@lumiere.com</p>}</PwaCard>{events.length === 0 ? <PwaEmptyState title="Nothing to do right now" description="Assigned events will appear here when your Ground Crew schedule is ready." /> : events.map((event) => <PwaCard key={event.id} title={event.name} subtitle={`${dateLabel(event.date)} · ${event.venue}`}><div className="space-y-3"><div className="relative grid grid-cols-4 gap-1">{FIELD_STAGES.map((stage, index) => { const previousDone = canOpenStage(event.id, index); const done = confirmedStages[`${event.id}:${stage}`]; const editable = editableStages.has(stage); const isCurrent = previousDone && !done && editable; return <button key={stage} type="button" disabled={!previousDone} onClick={() => { setSelectedEventId(event.id); setActiveStage(stage) }} className={`relative z-10 min-w-0 rounded-xl px-1 py-2.5 text-[10px] font-semibold transition-colors ${done ? 'bg-emerald-500/15 text-emerald-700' : isCurrent ? 'bg-primary/15 text-primary ring-1 ring-primary/50' : previousDone ? 'bg-muted text-muted-foreground' : 'bg-muted text-muted-foreground opacity-60'}`}><span className={`mx-auto mb-1 flex size-7 items-center justify-center rounded-full border text-xs ${isCurrent ? 'border-primary bg-primary text-primary-foreground' : 'border-current'}`}>{done ? '✓' : index + 1}</span><span className="block truncate">{stage.replace(' Release', '').replace('Warehouse ', '')}</span><span className="mt-0.5 block text-[8px] font-normal">{editable ? 'Your stage' : 'Read-only'}</span></button>})}</div><div className="flex items-center justify-between border-t border-border pt-3 text-[10px] text-muted-foreground"><span>{event.items.length} manifest items</span><span>Saved locally · pending sync</span></div></div></PwaCard>)}</div>
}

void FieldConsole

function FieldEventWorkflow({ event, isLead, damageReports, onOpenCamera }: { event: EventItem; isLead: boolean; damageReports: DamageReport[]; onOpenCamera: () => void }) {
  const [selectedStage, setSelectedStage] = useState<FieldStage>('Venue Arrival')
  const [itemStates, setItemStates] = useState<Record<string, FieldItemState>>({})
  const [completedStages, setCompletedStages] = useState<Partial<Record<FieldStage, boolean>>>({})
  const currentStageIndex = FIELD_STAGES.findIndex((stage) => !completedStages[stage])
  const selectedIndex = FIELD_STAGES.indexOf(selectedStage)
  const inScope = true
  const isCurrent = selectedIndex === currentStageIndex
  const stageKey = `${event.id}:${selectedStage}`
  const itemCount = event.items.length
  const states = event.items.map((item) => itemStates[`${stageKey}:${item.id}`] ?? 'Not checked')
  const completedCount = states.filter((state) => state !== 'Not checked').length
  const canComplete = isLead && isCurrent && completedCount === itemCount
  const markItem = (itemId: string, state: FieldItemState) => setItemStates((current) => ({ ...current, [`${stageKey}:${itemId}`]: state }))

  return <div className="space-y-4">
    <div><h1 className="font-serif text-xl font-bold">{event.name}</h1><p className="mt-1 text-xs text-muted-foreground">{event.venue || 'Venue not provided'}</p></div>
    <div className="rounded-2xl border border-border bg-card p-3">
      <div className="relative grid grid-cols-2 gap-1 after:absolute after:left-[12%] after:right-[12%] after:top-4 after:h-px after:bg-border">{FIELD_STAGES.map((stage, index) => { const done = Boolean(completedStages[stage]); const current = index === currentStageIndex; const allowed = true; return <button key={stage} type="button" onClick={() => setSelectedStage(stage)} className={`min-w-0 rounded-xl px-1 py-2 text-center ${current ? 'bg-primary/10 text-primary ring-1 ring-primary/40' : 'text-muted-foreground'} ${!allowed ? 'opacity-60' : ''}`}><span className={`relative z-10 mx-auto flex size-8 items-center justify-center rounded-full border text-xs font-bold ${done ? 'border-emerald-500 bg-emerald-500 text-white' : current ? 'size-9 border-primary bg-primary text-primary-foreground' : 'border-current bg-muted'}`}>{done ? '✓' : index + 1}</span><span className="mt-1 block min-h-5 text-[9px] font-semibold leading-tight">{stage === 'Venue Arrival' ? <><span>Ingress</span><br /><span className="font-normal text-[8px]">Venue Arrival</span></> : <><span>Egress</span><br /><span className="font-normal text-[8px]">Warehouse Return</span></>}</span>{!allowed && <span className="mt-1 block text-[8px]">View only</span>}</button> })}</div>
    </div>
    <section className="rounded-2xl border border-border bg-card p-3">
      <div className="mb-3 flex items-center justify-between"><div><h2 className="font-serif text-base font-bold">{selectedStage}</h2><p className="text-[10px] text-muted-foreground">{completedCount} of {itemCount} items checked</p></div></div>
      {isCurrent && !isLead && <p className="mb-3 rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground">Only the Team Lead can tick this checklist.</p>}
      <div className="space-y-2">{event.items.length === 0 ? <PwaEmptyState title="No assets assigned" description="The event manifest is not available yet." /> : event.items.map((item) => { const state = itemStates[`${stageKey}:${item.id}`] ?? 'Not checked'; return <div key={item.id} className="flex items-center gap-2 rounded-xl border border-border p-2.5"><button type="button" disabled={!isCurrent || !inScope || !isLead} onClick={() => markItem(item.id, state === 'Verified' ? 'Not checked' : 'Verified')} className={`flex size-6 shrink-0 items-center justify-center rounded-md border ${state === 'Verified' ? 'border-primary bg-primary text-primary-foreground' : 'border-border'} disabled:opacity-50`}>{state === 'Verified' && <Check className="size-4" />}</button><div className="min-w-0 flex-1"><p className="truncate text-xs font-semibold">{item.name}</p><p className="text-[10px] text-muted-foreground">Qty {item.qty} · {state}</p></div><button type="button" disabled={!isCurrent || !inScope || !isLead} onClick={() => markItem(item.id, 'Missing')} className="rounded-lg px-2 py-1 text-[10px] text-muted-foreground disabled:opacity-40">•••</button></div> })}</div>
    </section>
    {isCurrent && (isLead ? <div className="space-y-2"><button type="button" disabled={!canComplete} onClick={() => { setCompletedStages((current) => ({ ...current, [selectedStage]: true })); const next = FIELD_STAGES[currentStageIndex + 1]; if (next) setSelectedStage(next) }} className="w-full rounded-xl bg-primary px-4 py-3 text-xs font-semibold text-primary-foreground disabled:opacity-40">Mark as {selectedStage === 'Venue Arrival' ? 'Delivered' : 'Returned'}</button></div> : <p className="rounded-xl border border-border p-3 text-xs text-muted-foreground">Waiting for the Team Lead to mark this stage</p>)}
    <section className="rounded-2xl border border-border bg-card p-4"><div className="text-center"><h2 className="font-serif text-base font-bold">Damage reporting</h2><p className="mt-1 text-[10px] text-muted-foreground">Capture photo evidence for damaged assets.</p><button type="button" aria-label="Take damage photo" onClick={onOpenCamera} className="mx-auto mt-3 flex min-h-12 w-full max-w-xs items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground shadow-sm transition hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"><Camera className="size-5" aria-hidden="true" /><span>Take Photo</span></button><p className="mt-2 text-[10px] text-muted-foreground">Tap to add evidence</p></div>{damageReports.length > 0 && damageReports.map((report) => <div key={report.id} className="border-b border-border py-2 text-xs last:border-0"><p className="font-semibold">{report.item}</p><p className="text-[10px] text-muted-foreground">by crew member · {report.capturedAt} · Waiting for review</p></div>)}</section>
  </div>
}

export function GroundCrewPage() {
  const { currentUser, adminName, adminEmail, adminRole, logout } = useAuth()
  const { events, staff, procurement, initiateEventEgress } = usePortal()
  const productionItems = useProductionItems(events, staff)
  const dispatchStore = useDispatchStore(events, staff, procurement)
  const declarations = useGroundCrewDeclarations()
  void declarations
  const [tab, setTab] = useState<Tab>('home')
  const [cameraShortcutOpen, setCameraShortcutOpen] = useState(false)
  const [taskView, setTaskView] = useState<'field' | 'production'>('field')
  const [selectedProductionAsset, setSelectedProductionAsset] = useState<'stage' | 'arch' | null>(null)
  // Canonical Manning operational assignments for authenticated user
  const [myAssignments, setMyAssignments] = useState<MyManningAssignmentDto[]>([])
  const [loadingAssignments, setLoadingAssignments] = useState(true)
  const [assignmentError, setAssignmentError] = useState<string | null>(null)
  const [mutatingAssignmentId, setMutatingAssignmentId] = useState<string | null>(null)
  const [isCachedData, setIsCachedData] = useState(false)
  const [blockerModalAssignment, setBlockerModalAssignment] = useState<MyManningAssignmentDto | null>(null)
  const [blockerReasonInput, setBlockerReasonInput] = useState('')
  const [blockerNotesInput, setBlockerNotesInput] = useState('')
  const [blockerError, setBlockerError] = useState<string | null>(null)

  // Operational Lead authority is derived strictly from Manning assignments per event (ManningAssignment.isLead),
  // NEVER inferred from names, roster position, legacy role labels, or mock stores.
  const effectiveRole = currentUser?.subRole || adminRole || 'Ground Crew'

  const isLeadForEvent = useCallback((eventId: string | null | undefined): boolean => {
    if (!eventId) return false
    if (adminRole === 'Admin' || adminRole === 'Event Admin') return true
    return myAssignments.some((a) => a.eventId === eventId && a.isLead === true)
  }, [adminRole, myAssignments])

  const hasAnyLead = myAssignments.some((a) => a.isLead === true)
  const accessLevel: AccessLevel =
    adminRole === 'Event Admin' || adminRole === 'Admin'
      ? 'Event Admin'
      : hasAnyLead
        ? 'Team Lead / Field Lead'
        : 'Ground Crew / Member'

  const activeAssignment = useMemo(() => {
    return [...myAssignments]
      .filter((assignment) => assignment.executionStatus !== 'Completed')
      .sort((a, b) => `${a.shiftDate ?? ''}${a.shiftStartTime ?? ''}`.localeCompare(`${b.shiftDate ?? ''}${b.shiftStartTime ?? ''}`))[0] ?? null
  }, [myAssignments])

  const derivedEvents = useMemo<EventItem[]>(() => {
  if (!activeAssignment || !events || events.length === 0) return adminEmail === 'crew@lumiere.com' ? [FIELD_PREVIEW_EVENT] : []
  const assignedEvent = events.find((event) => event.id === activeAssignment.eventId)
    if (!assignedEvent) return []
    // Single-Lock Assignment: Ground Crew receives only the one event in the active Manning assignment.
    return [{
      id: assignedEvent.id,
      name: assignedEvent.title,
      date: assignedEvent.targetDate,
      venue: assignedEvent.venue,
      status: 'Current',
      editable: true,
      phase: null,
      items: [],
    }]
  }, [activeAssignment, adminEmail, events])

  const [adminEventId, setAdminEventId] = useState('')
  const [crewEvents, setCrewEvents] = useState<EventItem[]>([])

  const loadAssignments = useCallback(async () => {
    setLoadingAssignments(true)
    setAssignmentError(null)
    const userId = currentUser?.id

    // 1. If online, attempt canonical REST first
    if (typeof navigator === 'undefined' || navigator.onLine) {
      try {
        const data = await fetchMyManningAssignments()
        setIsCachedData(false)

        // Store authoritative read snapshot into durable IndexedDB read_cache
        if (userId) {
          try {
            await setReadCache(userId, 'manning', 'my-assignments', data)
          } catch (cErr) {
            console.warn('[readCache] Failed to cache assignments:', cErr)
          }
        }

        if (userId) {
          const outbox = await getManningUserMutations(userId)
          const outboxMap = new Map(outbox.map((m) => [m.payload.assignmentId, m]))
          const merged = data.map((a) => {
            const m = outboxMap.get(a.assignmentId)
            if (m) {
              return {
                ...a,
                executionStatus: m.payload.status,
                blockerReason: m.payload.blockerReason || a.blockerReason,
                pendingSync: m.status === 'pending' || m.status === 'syncing',
                syncStatus: m.status,
                lastSyncError: m.lastError,
              }
            }
            return { ...a, pendingSync: false, syncStatus: 'confirmed' as const }
          })
          setMyAssignments(merged)
        } else {
          setMyAssignments(data)
        }
        setLoadingAssignments(false)
        return
      } catch (err: any) {
        console.warn('[GroundCrewPage] REST fetch failed, attempting read cache fallback:', err)
      }
    }

    // 2. Offline / network fallback: hydrate from user-scoped read_cache
    if (userId) {
      try {
        const cached = await getReadCache<MyManningAssignmentDto[]>(userId, 'manning', 'my-assignments')
        if (cached && Array.isArray(cached.data) && cached.data.length > 0) {
          const outbox = await getManningUserMutations(userId)
          const outboxMap = new Map(outbox.map((m) => [m.payload.assignmentId, m]))
          const merged = cached.data.map((a) => {
            const m = outboxMap.get(a.assignmentId)
            if (m) {
              return {
                ...a,
                executionStatus: m.payload.status,
                blockerReason: m.payload.blockerReason || a.blockerReason,
                pendingSync: m.status === 'pending' || m.status === 'syncing',
                syncStatus: m.status,
                lastSyncError: m.lastError,
              }
            }
            return { ...a, pendingSync: false, syncStatus: 'confirmed' as const }
          })
          setMyAssignments(merged)
          setIsCachedData(true)
          setLoadingAssignments(false)
          return
        }
      } catch (cErr) {
        console.warn('[GroundCrewPage] Read cache retrieval failed:', cErr)
      }
    }

    setAssignmentError('Network unavailable and no cached assignments found for this account.')
    setLoadingAssignments(false)
  }, [currentUser?.id])

  useEffect(() => {
    void loadAssignments()
  }, [loadAssignments])

  useEffect(() => {
    const handleFocus = () => {
      void loadAssignments()
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [loadAssignments])

  // Subscribe to offline replay engine for auto-sync and refresh
  useEffect(() => {
    const userId = currentUser?.id
    if (!userId) return

    const unsub = subscribeSyncEngine((status) => {
      if (status.state === 'idle' && status.lastSyncAt) {
        void loadAssignments()
      }
    })

    const handleOnlineReplay = () => {
      void triggerOutboxReplay(userId).then((res) => {
        if (res.synced > 0) {
          void loadAssignments()
        }
      })
    }
    window.addEventListener('online', handleOnlineReplay)

    return () => {
      unsub()
      window.removeEventListener('online', handleOnlineReplay)
    }
  }, [currentUser?.id, loadAssignments])

  const handleUpdateAssignmentStatus = async (
    assignmentId: string,
    req: { status: 'InProgress' | 'Completed' | 'Blocked'; blockerReason?: string | null; notes?: string | null },
  ): Promise<{ success: boolean; error?: string }> => {
    setMutatingAssignmentId(assignmentId)
    const userId = currentUser?.id || 'anonymous'
    const targetAssignment = myAssignments.find((a) => a.assignmentId === assignmentId)

    // 1. If offline, enqueue immediately to durable IndexedDB outbox
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      try {
        await queueManningStatusUpdate(userId, assignmentId, targetAssignment?.eventId, req)
        setMyAssignments((prev) =>
          prev.map((a) =>
            a.assignmentId === assignmentId
              ? {
                  ...a,
                  executionStatus: req.status,
                  blockerReason: req.blockerReason || a.blockerReason,
                  pendingSync: true,
                  syncStatus: 'pending',
                }
              : a,
          ),
        )
        const label =
          req.status === 'InProgress'
            ? 'Task marked In Progress (Pending Sync).'
            : req.status === 'Completed'
              ? 'Task marked Completed (Pending Sync).'
              : 'Task blocker queued (Pending Sync).'
        setToast(label)
        window.setTimeout(() => setToast(''), 4000)
        return { success: true }
      } catch (err: any) {
        setToast(`Failed to queue offline task: ${err.message}`)
        return { success: false, error: err.message }
      } finally {
        setMutatingAssignmentId(null)
      }
    }

    // 2. If online, attempt REST mutation with outbox fallback on network drop
    try {
      const res = await updateMyAssignmentExecutionStatus(assignmentId, req)
      if (res.success) {
        setMyAssignments((prev) =>
          prev.map((a) =>
            a.assignmentId === assignmentId
              ? { ...a, ...res.data, pendingSync: false, syncStatus: 'confirmed' }
              : a,
          ),
        )
        const label =
          req.status === 'InProgress'
            ? 'Task marked In Progress.'
            : req.status === 'Completed'
              ? 'Task marked Completed.'
              : 'Task blocker submitted to Manning ledger.'
        setToast(label)
        window.setTimeout(() => setToast(''), 4000)
        return { success: true }
      } else if (res.status === 0) {
        // Network drop during call
        await queueManningStatusUpdate(userId, assignmentId, targetAssignment?.eventId, req)
        setMyAssignments((prev) =>
          prev.map((a) =>
            a.assignmentId === assignmentId
              ? {
                  ...a,
                  executionStatus: req.status,
                  blockerReason: req.blockerReason || a.blockerReason,
                  pendingSync: true,
                  syncStatus: 'pending',
                }
              : a,
          ),
        )
        setToast('Network unavailable. Action saved to offline queue (Pending Sync).')
        window.setTimeout(() => setToast(''), 4000)
        return { success: true }
      } else {
        setToast(`Action rejected by server: ${res.error}`)
        window.setTimeout(() => setToast(''), 4500)
        return { success: false, error: res.error }
      }
    } catch (err: any) {
      try {
        await queueManningStatusUpdate(userId, assignmentId, targetAssignment?.eventId, req)
        setMyAssignments((prev) =>
          prev.map((a) =>
            a.assignmentId === assignmentId
              ? {
                  ...a,
                  executionStatus: req.status,
                  blockerReason: req.blockerReason || a.blockerReason,
                  pendingSync: true,
                  syncStatus: 'pending',
                }
              : a,
          ),
        )
        setToast('Action saved to offline queue (Pending Sync).')
        window.setTimeout(() => setToast(''), 4000)
        return { success: true }
      } catch (qErr: any) {
        const msg = err?.message || 'Network error updating assignment status.'
        setToast(`Update failed: ${msg}`)
        window.setTimeout(() => setToast(''), 4500)
        return { success: false, error: msg }
      }
    } finally {
      setMutatingAssignmentId(null)
    }
  }

  const handleSubmitBlocker = async (e: FormEvent) => {
    e.preventDefault()
    if (!blockerModalAssignment) return
    const reason = blockerReasonInput.trim()
    if (!reason) {
      setBlockerError('A detailed blocker reason is required.')
      return
    }
    setBlockerError(null)
    const res = await handleUpdateAssignmentStatus(blockerModalAssignment.assignmentId, {
      status: 'Blocked',
      blockerReason: reason,
      notes: blockerNotesInput.trim() || null,
    })
    if (res.success) {
      setBlockerModalAssignment(null)
    } else {
      setBlockerError(res.error || 'Server rejected blocker submission.')
    }
  }

  useEffect(() => {
    if (derivedEvents.length > 0) {
      setCrewEvents(derivedEvents)
      if (!adminEventId) {
        setAdminEventId(derivedEvents[0].id)
      }
      void loadDeclarationsFromBackend(derivedEvents)
    }
  }, [derivedEvents, adminEventId])

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const selectedEvent = selectedEventId ? crewEvents.find((event) => event.id === selectedEventId) ?? null : null
  const assignedBatch = useMemo(() => {
    const event = selectedEventId ? events.find((item) => item.id === selectedEventId) : events[0]
    return event ? (dispatchStore.get(event.id) ?? []).find((batch) => !batch.isArchived && batch.crew.length > 0) ?? null : null
  }, [dispatchStore, events, selectedEventId])
  const [reports, setReports] = useState<DamageReport[]>([])
  const [offlineItems, setOfflineItems] = useState<QueuedDeclaration[]>([])
  const [isSyncingQueue, setIsSyncingQueue] = useState(false)

  useEffect(() => {
    let active = true
    const loadQueue = async () => {
      try {
        const q = await getPendingQueue()
        if (active) setOfflineItems(q)
      } catch {}
    }
    void loadQueue()

    const unsub = subscribeOfflineSync((_count, syncing) => {
      if (!active) return
      setIsSyncingQueue(syncing)
      void loadQueue()
    })

    return () => {
      active = false
      unsub()
    }
  }, [])

  const handleTriggerSync = async () => {
    setIsSyncingQueue(true)
    try {
      const res = await triggerOfflineReplay()
      if (res.syncedCount > 0) {
        setToast(`Synchronized ${res.syncedCount} queued condition report(s).`)
      } else if (res.errors > 0) {
        setToast(`Sync finished: ${res.errors} declaration(s) rejected or conflicted by server.`)
      } else {
        setToast('No pending declarations to sync.')
      }
      window.setTimeout(() => setToast(''), 4000)
    } catch (err: any) {
      setToast(`Sync error: ${err?.message || 'Network error'}`)
      window.setTimeout(() => setToast(''), 4000)
    } finally {
      setIsSyncingQueue(false)
    }
  }

  const handleUpdateReport = async (
    reportId: string,
    updates: { quantity: number; description?: string; condition?: 'Damaged' | 'Missing'; expectedVersion: number },
  ): Promise<{ success: boolean; error?: string; code?: string }> => {
    const res = await updateGroundCrewDeclaration(reportId, updates)
    if (res.success && res.declaration) {
      setReports((prev) =>
        prev.map((r) =>
          r.id === reportId
            ? {
                ...r,
                quantity: res.declaration!.quantity,
                description: res.declaration!.description,
                condition: res.declaration!.condition,
                declarationState: res.declaration!.declarationState,
                evidenceStatus: res.declaration!.evidenceStatus,
                reviewDeadlineAt: res.declaration!.reviewDeadlineAt,
                version: res.declaration!.version,
                isEditable: res.declaration!.isEditable,
              }
            : r,
        ),
      )
      setToast('Declaration updated within review window.')
      window.setTimeout(() => setToast(''), 3500)
      return { success: true }
    } else {
      if (res.code === 'DECLARATION_FINALIZED') {
        setReports((prev) =>
          prev.map((r) =>
            r.id === reportId ? { ...r, declarationState: 'Finalized', isEditable: false } : r,
          ),
        )
      }
      return { success: false, error: res.error, code: res.code }
    }
  }

  const [requests] = useState<CrewRequest[]>([])
  void offlineItems
  void isSyncingQueue
  void handleTriggerSync
  void handleUpdateReport
  void requests
  const [showReport, setShowReport] = useState(false)
  const [reportItem, setReportItem] = useState<EventItem['items'][number] | null>(null)
  const [toast, setToast] = useState('')
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  })
  const [notes] = useState<Record<string, string>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const stored = localStorage.getItem('__lumiere_crew_notes__')
      return stored ? JSON.parse(stored) : {}
    } catch {
      return {}
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('__lumiere_crew_notes__', JSON.stringify(notes))
    } catch {
      // ignore
    }
  }, [notes])

  const [handoffNotes, setHandoffNotes] = useState<Record<string, string>>({})
  const [egressErrors, setEgressErrors] = useState<Record<string, string>>({})
  void setHandoffNotes
  void egressErrors

  const [requestOpen, setRequestOpen] = useState(false)
  const [requestType, setRequestType] = useState('Sick leave')
  const [requestDate, setRequestDate] = useState('2026-09-25')
  const [requestNote, setRequestNote] = useState('')

  const [isSubmittingReport, setIsSubmittingReport] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)

  const openReport = (item: EventItem['items'][number]) => {
    setReportItem(item)
    setReportError(null)
    setShowReport(true)
  }
  void openReport

  const submitReport = async (
    event: FormEvent<HTMLFormElement>,
    capture?: { photoDataUrl: string; sha256Hash: string; meta: HavaPhotoMetadata },
    noPhotographicEvidence = false,
  ) => {
    event.preventDefault()
    if (!reportItem || !selectedEvent) return

    const formData = new FormData(event.currentTarget)
    const condition = (formData.get('condition') as 'Damaged' | 'Missing') || 'Damaged'
    const qty = Number(formData.get('quantity') || '1')
    const desc = (formData.get('description') as string) || ''

    if (condition === 'Damaged' && !capture && !noPhotographicEvidence) {
      setToast('Photo evidence is required for damaged items, or mark as an exceptional no-photo report.')
      window.setTimeout(() => setToast(''), 3500)
      return
    }

    setIsSubmittingReport(true)
    setReportError(null)

    try {
      const result = await submitGroundCrewDeclaration({
        eventId: selectedEvent.id,
        eventName: selectedEvent.name,
        assetId: reportItem.id,
        item: reportItem.name,
        quantity: qty,
        condition,
        description: desc,
        submittedBy: adminName || 'Ground Crew Member',
        submittedAt: new Date().toISOString(),
        submittedRole: isLeadForEvent(selectedEvent.id) ? 'Field Lead' : 'Member',
        photoUrl: capture?.photoDataUrl,
        sha256Hash: capture?.sha256Hash,
        gpsCoordinates: capture?.meta.gpsCoordinates,
        noPhotographicEvidence,
      })

      if (result.success) {
        if (result.queuedOffline) {
          setToast('Report queued locally for offline sync (not yet confirmed by server).')
        } else {
          setToast(`Condition report confirmed by server (ID: ${result.reportId.slice(0, 8)}).`)
        }
        window.setTimeout(() => setToast(''), 4000)

        const newReport: DamageReport = {
          id: result.queuedOffline ? result.declaration.id : result.reportId,
          event: selectedEvent.name,
          item: reportItem.name,
          phase: selectedEvent.phase ?? 'Pre-Event Setup',
          quantity: qty,
          description: desc,
          condition,
          photo: capture?.photoDataUrl ?? '',
          capturedAt: capture?.meta.capturedAt
            ? new Date(capture.meta.capturedAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
            : 'Just now',
          location: selectedEvent.venue,
          sha256Hash: capture?.sha256Hash,
          gpsCoordinates: capture?.meta.gpsCoordinates,
          declarationState: result.declaration.declarationState || 'Reviewable',
          evidenceStatus:
            result.declaration.evidenceStatus ||
            (noPhotographicEvidence ? 'No Photographic Evidence' : 'Unverifiable'),
          isTemporallyValid: result.declaration.isTemporallyValid,
          reviewDeadlineAt: result.declaration.reviewDeadlineAt,
          version: result.declaration.version || 1,
          isEditable: result.declaration.isEditable ?? true,
          offlineSyncStatus: result.queuedOffline ? 'locally queued' : 'server accepted',
        }

        setReports((prev) => [newReport, ...prev])
        setShowReport(false)
        setReportItem(null)
      } else {
        setReportError(result.error)
        setToast(`Submission failed: ${result.error}`)
        window.setTimeout(() => setToast(''), 4500)
      }
    } catch (err: any) {
      const errMsg = err?.message || 'Unexpected submission error'
      setReportError(errMsg)
      setToast(`Submission failed: ${errMsg}`)
      window.setTimeout(() => setToast(''), 4500)
    } finally {
      setIsSubmittingReport(false)
    }
  }

  const handleDecision = (declarationId: string, decision: 'Confirmed' | 'Rejected') => {
    decideGroundCrewDeclaration(declarationId, decision, adminName || 'Event Admin')
    setToast(`Declaration ${declarationId} ${decision.toLowerCase()} by ${adminName || 'Event Admin'}.`)
    window.setTimeout(() => setToast(''), 3500)
  }
  void handleDecision

  const advancePhase = async (eventId: string) => {
    const targetEvent = crewEvents.find((e) => e.id === eventId)
    if (!targetEvent || !targetEvent.phase) return

    const order: CheckpointPhase[] = ['Dispatch Loading', 'Venue Arrival', 'Pre-Event Setup', 'Post-Event Egress']
    const idx = order.indexOf(targetEvent.phase)
    if (idx < 0 || idx >= order.length - 1) return
    const nextPhase = order[idx + 1]

    if (!navigator.onLine) {
      try {
        const userId = adminEmail || 'crew'
        await queueOfflinePhaseAdvancement(userId, eventId, targetEvent.phase, nextPhase)
        setToast(`Checkpoint advanced to ${nextPhase} (Pending Sync).`)
        window.setTimeout(() => setToast(''), 3500)
      } catch (err) {
        console.warn('Failed to queue phase advancement:', err)
      }
    }

    setCrewEvents((prev) =>
      prev.map((item) => {
        if (item.id !== eventId) return item
        return { ...item, phase: nextPhase }
      })
    )
  }
  void advancePhase

  const handleStartEgress = async (eventId: string) => {
    const note = (handoffNotes[eventId] || '').trim()
    if (!note) {
      setEgressErrors((prev) => ({
        ...prev,
        [eventId]: 'A handoff note is required before completing egress.',
      }))
      return
    }

    if (!isLeadForEvent(eventId)) {
      setEgressErrors((prev) => ({
        ...prev,
        [eventId]: 'Field Lead operational authority is required to initiate post-event egress for this event.',
      }))
      return
    }

    if (!navigator.onLine) {
      setEgressErrors((prev) => ({
        ...prev,
        [eventId]:
          'Network unavailable. Consequential post-event egress accountability requires an active connection. Reconnect to initiate.',
      }))
      return
    }

    setEgressErrors((prev) => ({ ...prev, [eventId]: '' }))

    try {
      const res = await initiateEventEgress(eventId, note)
      if (!res.success) {
        setEgressErrors((prev) => ({
          ...prev,
          [eventId]: res.error || 'Failed to initiate partial egress with server.',
        }))
        return
      }

      setCrewEvents((prev) =>
        prev.map((item) => {
          if (item.id !== eventId) return item
          return { ...item, status: 'Completed' }
        }),
      )

      const isDup = res.isDuplicate ? ' (active session resumed)' : ''
      setToast(
        `Post-Event Egress initiated for ${selectedEvent?.name || 'event'}${isDup}. Post-egress accountability active.`,
      )
      window.setTimeout(() => setToast(''), 3500)
    } catch (err: any) {
      setEgressErrors((prev) => ({
        ...prev,
        [eventId]: err?.message || 'Network error initiating egress.',
      }))
    }
  }
  void handleStartEgress

  const submitRequest = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // No backend HR/workforce-request endpoint exists. This action does not persist data.
    // Display a clear notice instead of a fake success state.
    setRequestOpen(false)
    setRequestNote('')
    setToast('Workforce requests are not yet supported in this version. Contact your Workforce Admin directly.')
    window.setTimeout(() => setToast(''), 5000)
  }

  const navItems: PwaNavItem[] = [
    { id: 'home', label: 'Home', icon: CalendarDays },
  { id: 'tasks', label: 'Tasks', icon: ClipboardList },
  { id: 'history', label: 'History', icon: History },
  { id: 'account', label: 'Profile', icon: UserCircle2 },
  ]

  return (
    <div className="min-h-screen bg-background text-foreground pb-24">
      {/* Shared PWA Station Header */}
      <PwaHeader
  title={
  tab === 'home'
  ? 'Home'
            : tab === 'tasks'
  ? selectedEvent ? selectedEvent.name : 'Tasks'
                : adminName || 'Profile'
        }
            subtitle={
          tab === 'home'
            ? undefined
            : tab === 'tasks'
  ? selectedEvent ? `${selectedEvent.venue} • ${dateLabel(selectedEvent.date)}` : 'Field and production work'
                : adminEmail || undefined
        }
        roleName={currentUser?.groundCrewSubRole === 'Warehouse' ? 'Warehouse Crew' : 'Field Crew'}
        subRole={hasAnyLead ? 'Team Lead' : undefined}
        icon={
          tab === 'home' ? (
            <CalendarDays className="size-5 text-primary" />
          ) : tab === 'tasks' ? (
  <ClipboardList className="size-5 text-primary" />
          ) : (
            <UserCircle2 className="size-5 text-primary" />
          )
        }
      />

      {/* Main Tab Content */}
      <main className="mx-auto w-full max-w-[440px] px-4 pt-4 space-y-4">
        {tab === 'home' && <GroundCrewSyncPill assignments={myAssignments} isCachedData={isCachedData} />}
        {tab === 'home' && assignedBatch && <PwaCard title="Assigned delivery" subtitle="Trip crew"><div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold">{assignedBatch.vehicleType} · {assignedBatch.plateNumber}</p><p className="mt-1 text-xs text-muted-foreground">{assignedBatch.direction === 'outbound' ? 'Outbound' : 'Return'} · {assignedBatch.stage}</p></div><div className="text-right"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Crew</p><p className="mt-1 text-sm font-semibold">{assignedBatch.crew.length}</p></div></div><div className="mt-3 flex flex-wrap gap-1.5">{assignedBatch.crew.map((member) => <span key={member.id} className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">{member.name}</span>)}</div></PwaCard>}

        {tab === 'home' && (
          <Home
            events={crewEvents}
            greetingName={adminName || currentUser?.name || ''}
            onOpenToday={(item) => { setSelectedEventId(item.id); setTab('tasks') }}
                      assignments={myAssignments}
                      loadingAssignments={loadingAssignments}
            assignmentError={assignmentError}
            isCachedData={isCachedData}
          />
        )}

        {tab === 'home' && (
          <CalendarView
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            assignments={myAssignments}
            events={crewEvents}
            loading={loadingAssignments}
            error={assignmentError}
  isLeadForEvent={isLeadForEvent}
  crewScope={currentUser?.groundCrewSubRole === 'Warehouse' ? 'Warehouse Crew' : 'Field Crew'}
  />
        )}

        {(tab === 'tasks' || tab === 'history') && <div className="space-y-4">
          {tab === 'tasks' && <div className="flex items-center gap-1 rounded-2xl border border-border bg-card p-1"><button type="button" onClick={() => setTaskView('field')} className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold ${taskView === 'field' ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>Field</button><button type="button" onClick={() => setTaskView('production')} className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold ${taskView === 'production' ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>Production</button></div>}
          {tab === 'tasks' && taskView === 'field' && (selectedEvent ?? crewEvents.find((event) => event.status !== 'Completed')) ? <FieldEventWorkflow event={(selectedEvent ?? crewEvents.find((event) => event.status !== 'Completed'))!} isLead={isLeadForEvent((selectedEvent ?? crewEvents.find((event) => event.status !== 'Completed'))!.id)} damageReports={reports.filter((report) => report.event === (selectedEvent ?? crewEvents.find((event) => event.status !== 'Completed'))?.name)} onOpenCamera={() => { const activeEvent = selectedEvent ?? crewEvents.find((event) => event.status !== 'Completed') ?? HOME_PREVIEW_EVENT; if (activeEvent?.items[0]) { openReport(activeEvent.items[0]); setCameraShortcutOpen(false) } }} /> : tab === 'tasks' && taskView === 'production' ? <ProductionHandoffCard items={productionItems} /> : tab === 'tasks' && taskView === 'field' ? <PwaEmptyState title="Nothing to do right now" description="Assigned events will appear here when your Ground Crew schedule is ready." /> : tab === 'history' ? <div className="space-y-4"><PwaCard title="Past events" subtitle="Completed crew work"><div className="space-y-2">{(crewEvents.filter((event) => event.status === 'Completed').length > 0 ? crewEvents.filter((event) => event.status === 'Completed') : HISTORY_DEMO_EVENTS).map((event) => <div key={event.id} className="rounded-xl border border-border p-3"><p className="text-sm font-semibold">{event.name}</p><p className="text-xs text-muted-foreground">{event.venue} · {dateLabel(event.date)}</p><p className="mt-2 text-[10px] font-semibold text-emerald-600">Completed</p></div>)}</div></PwaCard><PwaCard title="Damage reports" subtitle="Submitted crew reports"><div className="space-y-2">{(reports.length > 0 ? reports : HISTORY_DEMO_REPORTS).map((report) => <div key={report.id} className="rounded-xl border border-border p-3"><p className="text-sm font-semibold">{report.item}</p><p className="text-xs text-muted-foreground">{report.event} · {report.capturedAt}</p><p className="mt-2 text-[10px] font-semibold text-muted-foreground">{'status' in report ? report.status : report.declarationState}</p></div>)}</div></PwaCard></div> : <PwaCard title="Production" subtitle="Bespoke asset progress"><div className="space-y-3"><div className="space-y-2"><div className="rounded-xl border border-border p-3"><button type="button" onClick={() => setSelectedProductionAsset('stage')} className="w-full text-left"><div className="flex items-start justify-between gap-2"><div><p className="text-sm font-semibold">Custom Modular Velvet Stage Platform</p><p className="mt-1 text-xs font-semibold text-primary">65% complete �� Due Thu</p></div></div></button><div className="mt-2 h-1.5 rounded-full bg-muted"><div className="h-full w-2/3 rounded-full bg-amber-500" /></div><p className="mt-1 text-[9px] text-muted-foreground">Next: complete fabrication check</p></div><div className="rounded-xl border border-border p-3"><button type="button" onClick={() => setSelectedProductionAsset('arch')} className="w-full text-left"><div className="flex items-start justify-between gap-2"><div><p className="text-sm font-semibold">Modular Arch Panel</p><p className="mt-1 text-xs font-semibold text-primary">100% complete · Due Fri</p></div></div></button><p className="mt-2 text-[9px] text-muted-foreground">Next: final quality check</p>{selectedProductionAsset && <div className="fixed inset-0 z-50 flex items-end bg-black/50 p-3" role="dialog" aria-modal="true" aria-label="Production asset details"><div className="w-full rounded-2xl border border-border bg-card p-4 shadow-xl"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-wide text-primary">Bespoke asset</p><h2 className="mt-1 font-serif text-lg font-bold">{selectedProductionAsset === 'stage' ? 'Custom Modular Velvet Stage Platform' : 'Modular Arch Panel'}</h2></div><button type="button" onClick={() => setSelectedProductionAsset(null)} className="rounded-lg px-2 py-1 text-sm text-muted-foreground">Close</button></div><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><div><p className="text-muted-foreground">Status</p><p className="mt-1 font-semibold">{selectedProductionAsset === 'stage' ? 'In progress' : 'Ready'}</p></div><div><p className="text-muted-foreground">Owner</p><p className="mt-1 font-semibold">Production team</p></div><div><p className="font-semibold text-primary">Due date</p><p className="mt-1 text-sm font-bold text-primary">{selectedProductionAsset === 'stage' ? 'Thursday' : 'Friday'}</p></div><div><p className="text-muted-foreground">Next action</p><p className="mt-1 font-semibold">{selectedProductionAsset === 'stage' ? 'Complete fabrication check' : 'Final quality check'}</p></div></div><button type="button" onClick={() => setSelectedProductionAsset(null)} className="mt-4 w-full rounded-xl bg-primary px-4 py-3 text-xs font-semibold text-primary-foreground">Done</button></div></div>}</div></div></div><div className="hidden" aria-hidden="true"><div className="min-w-[430px]"><div className="mb-2 grid grid-cols-[132px_repeat(5,1fr)] gap-1 text-[9px] text-muted-foreground"><span>Task</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span></div><div className="space-y-2"><div className="grid grid-cols-[132px_repeat(5,1fr)] items-center gap-1"><span className="truncate text-[10px] font-semibold">Design &amp; prep</span><span className="col-span-2 h-5 rounded bg-primary/70" /><span /><span /><span /></div><div className="grid grid-cols-[132px_repeat(5,1fr)] items-center gap-1"><span className="truncate text-[10px] font-semibold">Fabrication</span><span /><span className="col-span-3 h-5 rounded bg-amber-500/70" /><span /></div><div className="grid grid-cols-[132px_repeat(5,1fr)] items-center gap-1"><span className="truncate text-[10px] font-semibold">Assembly check</span><span /><span /><span /><span className="col-span-2 h-5 rounded bg-emerald-500/70" /></div></div></div></div><div className="mt-4 space-y-2 border-t border-border pt-3"><div className="flex items-center justify-between text-[10px]"><span>Custom Modular Velvet Stage Platform</span><span className="text-primary">In progress</span></div><div className="flex items-center justify-between text-[10px]"><span>Modular Arch Panel</span><span className="text-emerald-600">Ready</span></div></div></PwaCard>}
        </div>}

        {tab === 'account' && (
          <Account
            name={adminName || 'Ground Crew'}
            email={adminEmail || 'crew@lumiere.internal'}
  accessLevel={accessLevel}
  effectiveRole={effectiveRole}
  onLogout={logout}
          />
        )}
      </main>

      {/* Shared Bottom Navigation */}
      <PwaBottomNav items={navItems} activeId={tab} onSelect={(id) => setTab(id as Tab)} />

      {/* Toast Notification */}
      {toast && <PwaToast message={toast} />}

  {/* Shared Modals */}
  <HavaCameraCaptureModal
    isOpen={cameraShortcutOpen}
    onClose={() => setCameraShortcutOpen(false)}
    onCaptureComplete={() => {
      setCameraShortcutOpen(false)
      setToast('Camera evidence captured. Attach it to a damage request from Requests.')
      window.setTimeout(() => setToast(''), 3500)
    }}
    itemName="Field Crew evidence"
    eventName={crewEvents[0]?.name ?? 'Active Ground Crew event'}
  />
  {blockerModalAssignment && (
        <PwaModal
          isOpen={Boolean(blockerModalAssignment)}
          onClose={() => {
            if (!mutatingAssignmentId) {
              setBlockerModalAssignment(null)
              setBlockerError(null)
            }
          }}
          title="Report Execution Blocker"
          subtitle={`${blockerModalAssignment.taskTitle} • ${blockerModalAssignment.eventName}`}
        >
          <form onSubmit={handleSubmitBlocker} className="space-y-4">
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
              Reporting a blocker marks this assignment as Blocked on the live Manning ledger and alerts warehouse operations.
            </div>

            <label className="block text-xs font-semibold text-foreground">
              Blocker Reason <span className="text-destructive">*</span>
              <textarea
                name="blockerReason"
                required
                rows={3}
                value={blockerReasonInput}
                onChange={(e) => setBlockerReasonInput(e.target.value)}
                disabled={Boolean(mutatingAssignmentId)}
                placeholder="Explain the obstacle preventing task progress (e.g. missing items, vehicle delay, safety lock)..."
                className="mt-1 w-full rounded-xl border border-input bg-background p-3 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="block text-xs font-semibold text-foreground">
              Operational Notes (Optional)
              <textarea
                name="notes"
                rows={2}
                value={blockerNotesInput}
                onChange={(e) => setBlockerNotesInput(e.target.value)}
                disabled={Boolean(mutatingAssignmentId)}
                placeholder="Additional details for the team..."
                className="mt-1 w-full rounded-xl border border-input bg-background p-3 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            {blockerError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                {blockerError}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <PwaButton
                type="submit"
                disabled={Boolean(mutatingAssignmentId) || !blockerReasonInput.trim()}
                variant="destructive"
                size="md"
                className="flex-1"
              >
                {mutatingAssignmentId ? 'Submitting Blocker...' : 'Submit Blocker'}
              </PwaButton>
              <PwaButton
                type="button"
                onClick={() => {
                  setBlockerModalAssignment(null)
                  setBlockerError(null)
                }}
                disabled={Boolean(mutatingAssignmentId)}
                variant="ghost"
                size="md"
              >
                Cancel
              </PwaButton>
            </div>
          </form>
        </PwaModal>
      )}

      {showReport && reportItem && selectedEvent && (
        <PwaModal
          isOpen={showReport}
          onClose={() => {
            if (!isSubmittingReport) {
              setShowReport(false)
              setReportError(null)
            }
          }}
          title="Report Item Condition"
          subtitle={`${reportItem.name} • ${selectedEvent.name}`}
        >
          <DamageForm
            item={reportItem}
            event={selectedEvent.name}
            phase={selectedEvent.phase ?? 'Pre-Event Setup'}
            onSubmit={submitReport}
            isSubmitting={isSubmittingReport}
            errorMessage={reportError}
          />
        </PwaModal>
      )}

      {requestOpen && (
        <PwaModal
          isOpen={requestOpen}
          onClose={() => setRequestOpen(false)}
          title="Submit Admin Request"
          subtitle="Submit leave or schedule requests to Workforce Admin"
        >
          <RequestForm
            type={requestType}
            setType={setRequestType}
            date={requestDate}
            setDate={setRequestDate}
            note={requestNote}
            setNote={setRequestNote}
            onSubmit={submitRequest}
          />
        </PwaModal>
      )}
    </div>
  )
}

const HOME_PREVIEW_EVENT: EventItem = {
  id: 'home-preview-event',
  name: 'Lumière Live Operational Demonstration',
  date: new Date().toISOString().slice(0, 10),
  venue: 'The Glasshouse, Makati',
  status: 'Current',
  editable: true,
  phase: 'Venue Arrival',
  items: [
    { id: 'home-preview-stage', name: 'Custom Modular Velvet Stage Platform 4×8', sku: 'STG-4X8', qty: 1, color: 'Onyx' },
    { id: 'home-preview-chairs', name: 'Ghost Chair', sku: 'CHR-GHOST', qty: 24, color: 'Clear' },
  ],
}

const HOME_PREVIEW_NEXT_EVENT: EventItem = {
  ...HOME_PREVIEW_EVENT,
  id: 'home-preview-next-event',
  name: 'Lumière Live Client Preview',
  date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  venue: 'BGC Arts Center',
  status: 'Upcoming',
  phase: null,
}

const HOME_PREVIEW_ASSIGNMENT = {
  assignmentId: 'home-preview-assignment',
  eventId: HOME_PREVIEW_EVENT.id,
  eventName: HOME_PREVIEW_EVENT.name,
  shiftDate: HOME_PREVIEW_EVENT.date,
  shiftStartTime: '08:00',
  shiftEndTime: '18:00',
  workArea: 'Field',
  taskTitle: 'Venue arrival verification',
  assignedRole: 'Field Crew',
  isLead: true,
  executionStatus: 'InProgress',
}

const HOME_PREVIEW_NEXT_ASSIGNMENT = {
  ...HOME_PREVIEW_ASSIGNMENT,
  assignmentId: 'home-preview-next-assignment',
  eventId: HOME_PREVIEW_NEXT_EVENT.id,
  eventName: HOME_PREVIEW_NEXT_EVENT.name,
  shiftDate: HOME_PREVIEW_NEXT_EVENT.date,
  shiftStartTime: '06:30',
  shiftEndTime: '16:00',
  taskTitle: 'Dispatch release preparation',
  workArea: 'Warehouse',
  assignedRole: 'Warehouse Crew',
  isLead: false,
  executionStatus: 'Assigned',
}

function Home({
  events,
  greetingName,
  onOpenToday,
  assignments,
  loadingAssignments,
  assignmentError,
  isCachedData,
}: {
  events: EventItem[]
  greetingName: string
  onOpenToday: (event: EventItem) => void
  assignments: MyManningAssignmentDto[]
  loadingAssignments: boolean
  assignmentError: string | null
  isCachedData?: boolean
}) {
  const manilaDate = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(value.includes('T') ? value : `${value}T00:00:00Z`))
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
  const previewMode = assignments.length === 0
  const displayAssignments = assignments.length === 0 ? [HOME_PREVIEW_ASSIGNMENT, { ...HOME_PREVIEW_ASSIGNMENT, assignmentId: 'home-preview-return', taskTitle: 'Warehouse return handoff', workArea: 'Warehouse', assignedRole: 'Warehouse Crew', isLead: false }, HOME_PREVIEW_NEXT_ASSIGNMENT] : assignments
  const displayEvents = events.length === 0 ? [HOME_PREVIEW_EVENT, HOME_PREVIEW_NEXT_EVENT] : events
  const grouped = Array.from(new Set(displayAssignments.map((a) => a.eventId))).map((eventId) => {
    const items = displayAssignments.filter((a) => a.eventId === eventId)
    const first = items[0]
    const event = displayEvents.find((e) => e.id === eventId)
    return { id: eventId, name: first.eventName || event?.name || 'Event', venue: event?.venue || first.workArea || 'Venue', date: first.shiftDate || event?.date || '', time: first.shiftStartTime, isLead: items.some((a) => a.isLead), items }
  }).filter((item) => item.date)
  const dated = grouped.map((item) => ({ ...item, manilaDate: manilaDate(item.date) }))
  const todayShift = dated.find((item) => item.manilaDate === today)
  const toEvent = (item: typeof grouped[number]) => displayEvents.find((e) => e.id === item.id) || { id: item.id, name: item.name, venue: item.venue, date: item.date, status: 'Upcoming' as EventStatus, editable: false, phase: null, items: [] }
  if (loadingAssignments) return <div className="space-y-3"><div className="h-5 w-20 animate-pulse rounded bg-muted" /><div className="h-44 animate-pulse rounded-2xl bg-muted" /><div className="h-28 animate-pulse rounded-2xl bg-muted" /></div>
  if (assignmentError && assignments.length === 0) return <p className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">Couldn&apos;t load your shifts. Try again.</p>

  const pendingActions = previewMode ? [
    { label: 'Confirm venue arrival checklist', detail: 'Lumière Live Operational Demonstration', action: () => onOpenToday(toEvent(todayShift ?? grouped[0])) },
    { label: 'Upload damage evidence', detail: '2 items need validation', action: () => undefined },
  ] : []

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-border bg-card px-4 py-3">
        <p className="font-serif text-xl font-bold">Hi, {greetingName.trim().split(/\s+/)[0] || 'there'}</p>
        <p className="mt-1 text-xs text-muted-foreground">Here&apos;s what needs your attention today.</p>
      </div>
      {previewMode && <div className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">Preview data is shown because this account has no active assignments yet.</div>}
      {pendingActions.length > 0 && <section aria-labelledby="pending-actions-heading" className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-3.5"><div className="mb-3 flex items-center justify-between"><h2 id="pending-actions-heading" className="font-serif text-base font-bold">Pending actions</h2><span className="rounded-full bg-amber-400/20 px-2 py-1 text-[10px] font-bold text-amber-700 dark:text-amber-200">{pendingActions.length} open</span></div><div className="space-y-2">{pendingActions.map((item) => <button key={item.label} type="button" onClick={item.action} className="flex w-full items-center justify-between gap-3 rounded-xl border border-amber-400/20 bg-background/50 p-3 text-left"><span className="min-w-0"><span className="block text-xs font-semibold">{item.label}</span><span className="mt-1 block truncate text-[10px] text-muted-foreground">{item.detail}</span></span><span aria-hidden="true" className="text-lg text-amber-600">›</span></button>)}</div></section>}
      <GroundCrewSyncPill assignments={displayAssignments as MyManningAssignmentDto[]} isCachedData={isCachedData} />
      <div className="grid grid-cols-3 gap-2"><div className="rounded-xl border border-border bg-card p-3"><p className="text-lg font-bold">{grouped.length}</p><p className="text-[10px] text-muted-foreground">Events</p></div><div className="rounded-xl border border-border bg-card p-3"><p className="text-lg font-bold">{displayAssignments.length}</p><p className="text-[10px] text-muted-foreground">Assignments</p></div><div className="rounded-xl border border-border bg-card p-3"><p className="text-lg font-bold">{displayAssignments.filter((assignment) => assignment.executionStatus === 'InProgress').length}</p><p className="text-[10px] text-muted-foreground">In progress</p></div></div>
      {todayShift ? (
        <button type="button" onClick={() => onOpenToday(toEvent(todayShift))} className="block w-full text-left">
          <PwaCard className="border-border/80 bg-card p-4" headerClassName="hidden">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <h2 className="max-w-[70%] font-serif text-base font-bold leading-tight">{todayShift.name}</h2>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground"><span className="size-2 rounded-full bg-muted-foreground/60" /> Today</span>
              </div>
              <p className="text-xs text-muted-foreground">{todayShift.venue || 'Venue not provided'}</p>
              {todayShift.time && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock className="size-3" /> Call time {formatTime(todayShift.time)}</p>}
              <div><p className="text-xs font-semibold leading-snug text-foreground">Stage 1 of 2 · Ingress</p><div className="mt-2 grid grid-cols-2 gap-1"><span className="h-1.5 rounded-full bg-primary" /><span className="h-1.5 rounded-full bg-muted" /></div></div>
            </div>
          </PwaCard>
        </button>
      ) : <PwaCard title="Today"><p className="text-sm text-muted-foreground">No shift today</p></PwaCard>}
    </div>
  )
}

export function MyAssignmentsSection({
  assignments,
  loading,
  error,
  isCachedData,
  cacheTimestamp,
  onRefresh,
  mutatingAssignmentId,
  onUpdateStatus,
  onOpenBlocker,
}: {
  assignments: MyManningAssignmentDto[]
  loading: boolean
  error: string | null
  isCachedData?: boolean
  cacheTimestamp?: string | null
  onRefresh: () => void
  mutatingAssignmentId: string | null
  onUpdateStatus: (
    assignmentId: string,
    req: { status: 'InProgress' | 'Completed' | 'Blocked'; blockerReason?: string | null; notes?: string | null },
  ) => Promise<{ success: boolean; error?: string }>
  onOpenBlocker: (assignment: MyManningAssignmentDto) => void
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-2">
          <ClipboardList className="size-4 text-primary" />
          <h3 className="font-serif text-sm font-semibold uppercase tracking-[0.14em] text-foreground">
            My Assignments
          </h3>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-lg bg-muted px-2 py-1 text-[0.65rem] font-semibold text-muted-foreground hover:bg-accent hover:text-foreground transition disabled:opacity-50"
          title="Refresh assignments"
        >
          <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {isCachedData && (
        <div className="flex items-center justify-between rounded-xl border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-800 dark:text-sky-200">
          <div className="flex items-center gap-2 font-medium">
            <span className="inline-block size-2 rounded-full bg-sky-500 animate-pulse" />
            <span>Cached Operational Data (Offline)</span>
          </div>
          {cacheTimestamp && (
            <span className="text-[0.65rem] opacity-75">
              Snapshot: {new Date(cacheTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      )}

      {loading && (
        <div className="space-y-2">
          <div className="animate-pulse rounded-2xl border border-border/60 bg-muted/40 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="h-4 w-28 rounded bg-muted-foreground/20" />
              <div className="h-4 w-16 rounded bg-muted-foreground/20" />
            </div>
            <div className="h-5 w-48 rounded bg-muted-foreground/20" />
            <div className="h-3 w-36 rounded bg-muted-foreground/20" />
          </div>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-3.5 text-xs text-destructive space-y-2">
          <div className="flex items-center gap-2 font-semibold">
            <AlertCircle className="size-4 shrink-0" />
            <span>Failed to load assignments</span>
          </div>
          <p className="text-[0.7rem] text-destructive/90 leading-relaxed">{error}</p>
          <PwaButton onClick={onRefresh} variant="outline" size="sm" className="w-full mt-1">
            Retry
          </PwaButton>
        </div>
      )}

      {!loading && !error && assignments.length === 0 && (
        <PwaEmptyState
          title="No Scheduled Assignments"
          description="No assignments have been scheduled for you."
        />
      )}

      {!loading && !error && assignments.length > 0 && (
        <div className="space-y-2.5">
          {assignments.map((item) => {
            const rawStatus = item.executionStatus || 'Assigned'
            const isCompleted = rawStatus === 'Completed'
            const isInProgress = rawStatus === 'InProgress' || rawStatus === 'In Progress'
            const isBlocked = rawStatus === 'Blocked'
            const isAssigned = !isCompleted && !isInProgress && !isBlocked
            const isMutatingThis = mutatingAssignmentId === item.assignmentId

            return (
              <PwaCard
                key={item.assignmentId || item.taskPoolItemId || `${item.eventId}-${item.taskTitle}`}
                className="p-3.5 space-y-3"
              >
                {/* Event & Status Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-primary">
                      <span>{item.eventName}</span>
                      {item.workArea && (
                        <>
                          <span className="text-muted-foreground/60">•</span>
                          <span className="text-muted-foreground">{item.workArea}</span>
                        </>
                      )}
                    </div>
                    <h4 className="font-serif text-sm font-bold text-foreground leading-snug">{item.taskTitle}</h4>
                  </div>

                  <div className="shrink-0 flex flex-col items-end gap-1">
                    {item.syncStatus === 'conflict' ? (
                      <PwaBadge variant="destructive" label="Conflict / Needs Attention" />
                    ) : isCompleted ? (
                      <PwaBadge
                        variant="accent"
                        label={item.pendingSync ? 'Completed — Pending Sync' : 'Completed'}
                      />
                    ) : isInProgress ? (
                      <PwaBadge
                        variant="subrole"
                        subRole="Field"
                        label={item.pendingSync ? 'In Progress — Pending Sync' : 'In Progress'}
                      />
                    ) : isBlocked ? (
                      <PwaBadge
                        variant="destructive"
                        label={item.pendingSync ? 'Blocked — Pending Sync' : 'Blocked'}
                      />
                    ) : (
                      <PwaBadge variant="neutral" label="Assigned" />
                    )}
                    <div className="flex items-center gap-1">
                      {item.isLead && <PwaBadge variant="accent" label="Lead" />}
                      <span className="text-[0.6rem] text-muted-foreground">{item.assignedRole || 'Field Crew'}</span>
                    </div>
                  </div>
                </div>

                {/* Timing and Operational Schedule */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1 text-[0.7rem]">
                    <CalendarDays className="size-3 text-muted-foreground" />
                    {dateLabel(item.shiftDate)}
                  </span>
                  {(item.shiftStartTime || item.shiftEndTime) && (
                    <span className="inline-flex items-center gap-1 text-[0.7rem]">
                      <Clock className="size-3 text-muted-foreground" />
                      {item.shiftStartTime || '--:--'} – {item.shiftEndTime || '--:--'}
                    </span>
                  )}
                  {item.startedAt && !isCompleted && (
                    <span className="inline-flex items-center gap-1 text-[0.65rem] text-primary">
                      Started: {new Date(item.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  {item.completedAt && (
                    <span className="inline-flex items-center gap-1 text-[0.65rem] text-emerald-600 dark:text-emerald-400">
                      Completed: {new Date(item.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>

                {/* Conflict / Needs Attention Alert Banner */}
                {item.syncStatus === 'conflict' && (
                  <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive space-y-1">
                    <div className="flex items-center gap-1.5 font-bold text-[0.68rem] uppercase tracking-wider text-destructive">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      <span>Conflict / Needs Attention:</span>
                    </div>
                    <p className="text-xs leading-relaxed font-medium pl-5">
                      {item.lastSyncError || 'Server rejected offline mutation. Task reassigned or invalid transition.'}
                    </p>
                  </div>
                )}

                {/* Task Description if present */}
                {item.taskDescription && (
                  <p className="rounded-xl border border-border/40 bg-muted/20 p-2.5 text-xs text-muted-foreground leading-relaxed">
                    {item.taskDescription}
                  </p>
                )}

                {/* Associated Asset or Pool Info */}
                {(item.assetName || item.taskPoolName) && (
                  <div className="flex flex-wrap items-center gap-2 text-[0.65rem]">
                    {item.assetName && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-secondary/80 px-2 py-0.5 font-medium text-foreground">
                        <Layers className="size-2.5 text-primary" />
                        Asset: {item.assetName}
                      </span>
                    )}
                    {item.taskPoolName && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                        <Briefcase className="size-2.5" />
                        Pool: {item.taskPoolName}
                      </span>
                    )}
                  </div>
                )}

                {/* Active Blocker Display Banner */}
                {isBlocked && (
                  <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold text-[0.68rem] uppercase tracking-wider text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      <span>Active Blocker Reported:</span>
                    </div>
                    <p className="text-xs leading-relaxed font-medium pl-5">{item.blockerReason || 'Blocker logged with Manning ledger.'}</p>
                  </div>
                )}

                {/* Execution Lifecycle Action Buttons */}
                {isAssigned && (
                  <div className="flex items-center gap-2 pt-1 border-t border-border/40">
                    <PwaButton
                      onClick={() => onUpdateStatus(item.assignmentId, { status: 'InProgress' })}
                      disabled={isMutatingThis}
                      variant="primary"
                      size="sm"
                      icon={<Play className="size-3.5" />}
                      className="flex-1"
                    >
                      {isMutatingThis ? 'Starting...' : 'Start Task'}
                    </PwaButton>
                    <PwaButton
                      onClick={() => onOpenBlocker(item)}
                      disabled={isMutatingThis}
                      variant="outline"
                      size="sm"
                      icon={<AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" />}
                      className="text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                    >
                      Report Blocker
                    </PwaButton>
                  </div>
                )}

                {isInProgress && (
                  <div className="flex items-center gap-2 pt-1 border-t border-border/40">
                    <PwaButton
                      onClick={() => onUpdateStatus(item.assignmentId, { status: 'Completed' })}
                      disabled={isMutatingThis}
                      variant="primary"
                      size="sm"
                      icon={<Check className="size-3.5" />}
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      {isMutatingThis ? 'Completing...' : 'Complete Task'}
                    </PwaButton>
                    <PwaButton
                      onClick={() => onOpenBlocker(item)}
                      disabled={isMutatingThis}
                      variant="outline"
                      size="sm"
                      icon={<AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" />}
                      className="text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                    >
                      Report Blocker
                    </PwaButton>
                  </div>
                )}

                {isBlocked && (
                  <div className="pt-1 border-t border-border/40">
                    <PwaButton
                      onClick={() => onUpdateStatus(item.assignmentId, { status: 'InProgress' })}
                      disabled={isMutatingThis}
                      variant="primary"
                      size="sm"
                      icon={<Play className="size-3.5" />}
                      className="w-full"
                    >
                      {isMutatingThis ? 'Resuming Task...' : 'Resume Task'}
                    </PwaButton>
                  </div>
                )}

                {isCompleted && (
                  <div className="border-t border-border/40 pt-2 flex items-center justify-between text-[0.68rem] text-emerald-600 dark:text-emerald-400 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <CheckCircle2 className="size-3.5" />
                      {item.pendingSync ? 'Completed — Pending Sync' : 'Task Execution Completed'}
                    </span>
                    <span className="text-[0.6rem] text-muted-foreground italic">
                      {item.pendingSync ? 'Saved in offline outbox' : 'Confirmed on ledger'}
                    </span>
                  </div>
                )}
              </PwaCard>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DecisionMode({
  declarations,
  accessLevel,
  adminEventId,
  events,
  onEventChange,
  onDecision,
}: {
  declarations: GroundCrewDeclaration[]
  accessLevel: AccessLevel
  adminEventId: string
  events: EventItem[]
  onEventChange: (value: string) => void
  onDecision: (id: string, decision: 'Confirmed' | 'Rejected') => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const assigned = declarations.filter((d) => d.eventId === adminEventId && d.status === 'Pending Event Admin')
  const approachingForEvent = assigned.filter((d) => getDeclarationAging(d.submittedAt, now).approaching)

  useEffect(() => {
    if (accessLevel !== 'Event Admin') return
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [accessLevel])

  return (
    <div className="space-y-4">
      <PwaCard
        title="Assigned Role & Access Tier"
        subtitle="Workforce Management & Manning Authority"
        action={<PwaBadge variant="accent" label={accessLevel} />}
      >
        {accessLevel === 'Event Admin' ? (
          <div className="mt-2 space-y-2">
            <label className="block text-xs font-semibold text-foreground">
              Assigned Event Scope
              <select
                value={adminEventId}
                onChange={(e) => onEventChange(e.target.value)}
                className="mt-1 w-full rounded-xl border border-input bg-background px-3 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.id})
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[0.68rem] text-muted-foreground leading-relaxed">
              Event Admin authority is scoped to this event. Unhandled declarations escalate to Manning after 48 hours.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Role tier is assigned through Workforce Management & Manning. Ground crew accounts cannot self-modify access privileges.
          </p>
        )}
      </PwaCard>

      {accessLevel !== 'Event Admin' ? (
        <PwaCard title="Base Privilege Level" subtitle={accessLevel}>
          <p className="text-xs leading-relaxed text-muted-foreground">
            You retain checkpoint reporting and condition submission privileges. Event Admin confirmation authority is managed separately in Manning.
          </p>
        </PwaCard>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-serif text-sm font-semibold tracking-[0.14em] uppercase text-foreground">
              Pending Declarations ({assigned.length})
            </h3>
            <ShieldCheck className="size-4 text-primary" />
          </div>

          {approachingForEvent.length > 0 && (
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-900 dark:text-amber-200">
              <div className="flex items-center gap-2 font-bold uppercase tracking-wider">
                <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
                Pending Escalation Warning
              </div>
              <p className="mt-1 leading-relaxed">
                {approachingForEvent.length} declaration(s) approaching safety cutoff. Unresolved items will auto-escalate.
              </p>
            </div>
          )}

          {assigned.length === 0 ? (
            <PwaEmptyState
              title="No Pending Declarations"
              description="All submitted condition and damage declarations for this event have been reviewed."
            />
          ) : (
            assigned.map((declaration) => (
              <PwaCard key={declaration.id} className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <PwaBadge
                      variant={declaration.condition === 'Damaged' ? 'destructive' : 'neutral'}
                      label={declaration.condition}
                    />
                    <h4 className="mt-1.5 font-serif text-base font-bold text-foreground">{declaration.item}</h4>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {declaration.quantity} unit(s) • Submitted by {declaration.submittedBy} ({declaration.submittedRole})
                    </p>
                  </div>
                  <span className="text-[0.65rem] font-bold text-amber-600 dark:text-amber-400">
                    Pending {getDeclarationAging(declaration.submittedAt, now).elapsedHours}h
                  </span>
                </div>
                <p className="text-xs text-foreground bg-muted/30 p-2.5 rounded-xl border border-border/50">
                  {declaration.description}
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <PwaButton
                    onClick={() => onDecision(declaration.id, 'Confirmed')}
                    variant="primary"
                    size="sm"
                    className="flex-1"
                  >
                    Confirm
                  </PwaButton>
                  <PwaButton
                    onClick={() => onDecision(declaration.id, 'Rejected')}
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                  >
                    Reject
                  </PwaButton>
                </div>
              </PwaCard>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function PhaseMap({ phase }: { phase: CheckpointPhase | null }) {
  if (!phase) return null  // no canonical dispatch phase — do not render stepper
  const order: CheckpointPhase[] = ['Dispatch Loading', 'Venue Arrival', 'Pre-Event Setup', 'Post-Event Egress']
  const activeIndex = order.indexOf(phase)
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="img" aria-label={`Event progress: ${phase}`}>
      {order.map((item, index) => {
        const state = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending'
        return (
          <div
            key={item}
            className={`rounded-xl border px-2.5 py-2 text-center text-[0.625rem] font-bold uppercase tracking-wider transition-all ${
              state === 'active'
                ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                : state === 'done'
                  ? 'border-primary/40 bg-secondary/80 text-foreground'
                  : 'border-border bg-card/60 text-muted-foreground'
            }`}
          >
            <div className="flex items-center justify-center gap-1">
              {state === 'done' && <Check className="size-3" />}
              {state === 'pending' && <Lock className="size-3" />}
              <span>{item}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function EventDetail({
  event,
  batches,
  handoffNote,
  onHandoffNoteChange,
  egressError,
  isLead,
  onAdvancePhase,
  onStartEgress,
  onBack,
  onReport,
}: {
  event: EventItem
  batches: DispatchBatch[]
  handoffNote: string
  onHandoffNoteChange: (value: string) => void
  egressError: string
  isLead: boolean
  onAdvancePhase: () => void
  onStartEgress: () => void
  onBack: () => void
  onReport: (item: EventItem['items'][number]) => void
}) {
  const { phase } = event
  return (
    <div className="space-y-4">
      <PwaButton onClick={onBack} variant="outline" size="sm" icon={<ChevronLeft className="size-4" />}>
        All Events
      </PwaButton>

      <PhaseMap phase={phase} />

      <PwaCard title="Transit Checkpoints" subtitle="Chain of Custody Batches">
        {batches.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No dispatch batch assigned to this event yet.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {batches.map((batch) => (
              <TransitBatchCard key={batch.id} batch={batch} />
            ))}
          </div>
        )}
      </PwaCard>

      {phase === 'Dispatch Loading' && (
        <PwaCard title="Dispatch Loading Handoff" subtitle="Checkpoint 1 of 4">
          <p className="text-xs text-muted-foreground leading-relaxed flex items-start gap-2">
            <PackageCheck className="mt-0.5 size-4 shrink-0 text-primary" />
            Confirm warehouse dispatch manifest loading and vehicle clearance.
          </p>
          <div className="mt-3 divide-y divide-border/60">
            {event.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-2 py-2.5 text-xs">
                <div>
                  <p className="font-bold text-foreground">{item.name}</p>
                  <p className="text-muted-foreground">{item.sku} • {item.qty} units • {item.color}</p>
                </div>
                <PwaBadge variant="subrole" subRole="Warehouse" label="Verified" />
              </div>
            ))}
          </div>
          <PwaButton onClick={onAdvancePhase} variant="primary" size="md" className="mt-4 w-full">
            Confirm Loading — Advance to Venue Arrival
          </PwaButton>
        </PwaCard>
      )}

      {phase === 'Venue Arrival' && (
        <PwaCard title="Venue Arrival Verification" subtitle="Checkpoint 2 of 4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Verify vehicle arrival and transit condition before unloading.
          </p>
          <div className="mt-3 divide-y divide-border/60">
            {event.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-2 py-2.5 text-xs">
                <div>
                  <p className="font-bold text-foreground">{item.name}</p>
                  <p className="text-muted-foreground">{item.sku} • {item.qty} units • {item.color}</p>
                </div>
                <PwaButton onClick={() => onReport(item)} variant="outline" size="sm" icon={<Camera className="size-3.5" />}>
                  Condition Check
                </PwaButton>
              </div>
            ))}
          </div>
          <PwaButton onClick={onAdvancePhase} variant="primary" size="md" className="mt-4 w-full">
            Confirm Arrival — Advance to Pre-Event Setup
          </PwaButton>
        </PwaCard>
      )}

      {phase === 'Pre-Event Setup' && (
        <PwaCard title="Pre-Event Setup Validation" subtitle="Checkpoint 3 of 4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Review each item group. Report damage or missing quantities before event activation.
          </p>
          <div className="mt-3 divide-y divide-border/60">
            {event.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-2 py-2.5 text-xs">
                <div>
                  <p className="font-bold text-foreground">{item.name}</p>
                  <p className="text-muted-foreground">{item.sku} • {item.qty} units • {item.color}</p>
                </div>
                <PwaButton onClick={() => onReport(item)} variant="outline" size="sm" icon={<Camera className="size-3.5" />}>
                  Report
                </PwaButton>
              </div>
            ))}
          </div>
          <PwaButton onClick={onAdvancePhase} variant="primary" size="md" className="mt-4 w-full">
            Confirm Setup — Advance to Post-Event Egress
          </PwaButton>
        </PwaCard>
      )}

      {phase === 'Post-Event Egress' && (
        <div className="space-y-4">
          <PwaCard title="Post-Event Egress Checklist" subtitle="Checkpoint 4 of 4">
            <p className="text-xs text-muted-foreground leading-relaxed flex items-start gap-2">
              <PackageCheck className="mt-0.5 size-4 shrink-0 text-primary" />
              The warehouse crew confirms every item is packed and truck-ready.
            </p>
            <div className="mt-3 divide-y divide-border/60">
              {event.items.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-2 py-2.5 text-xs">
                  <div>
                    <p className="font-bold text-foreground">{item.name}</p>
                    <p className="text-muted-foreground">{item.sku} • {item.qty} units • {item.color}</p>
                  </div>
                  <PwaBadge variant="subrole" subRole="Field" label="Egress Ready" />
                </div>
              ))}
            </div>
            <div className="mt-4 border-t border-border/80 pt-3 space-y-3">
              <label className="block text-xs font-semibold text-foreground">
                Field Lead Handoff Note <span className="text-destructive">*</span>
                <textarea
                  value={handoffNote}
                  onChange={(e) => onHandoffNoteChange(e.target.value)}
                  rows={3}
                  disabled={!isLead}
                  placeholder={isLead ? "Where are damaged items placed? (prevents duplicate reporting on arrival)" : "Field Lead operational authority required to submit handoff note."}
                  className="mt-1 w-full rounded-xl border border-input bg-background p-3 text-xs focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                />
              </label>
              {egressError && <p className="text-xs text-destructive font-medium">{egressError}</p>}
              {!isLead && (
                <p className="text-xs text-amber-700 dark:text-amber-300 font-medium">
                  Post-event egress initiation requires Event Lead operational authority. Ordinary members may view and complete individual returned items below.
                </p>
              )}
              <PwaButton onClick={onStartEgress} disabled={!isLead} variant="primary" size="md" className="w-full">
                {isLead ? 'Initiate Post-Event Egress Accountability' : 'Event Lead Required to Initiate Egress'}
              </PwaButton>
            </div>
          </PwaCard>

          <PartialEgressSection eventId={event.id} eventTitle={event.name} isLead={isLead} />
        </div>
      )}
    </div>
  )
}

function TransitBatchCard({ batch }: { batch: DispatchBatch }) {
  const vehicleLabel = [batch.vehicleType, batch.plateNumber].filter(Boolean).join(' - ')
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="font-mono text-[0.65rem] font-bold text-muted-foreground">{batch.id}</span>
          <p className="font-bold text-foreground">{batch.driverName || 'Transit Driver'}</p>
        </div>
        <PwaBadge
          variant="accent"
          label="IN TRANSIT"
        />
      </div>
      {vehicleLabel && (
        <p className="mt-1 text-[0.65rem] text-muted-foreground">Vehicle: {vehicleLabel}</p>
      )}
    </div>
  )
}

function DamageForm({
  item,
  event,
  phase,
  onSubmit,
  isSubmitting = false,
  errorMessage = null,
}: {
  item: EventItem['items'][number]
  event: string
  phase: CheckpointPhase
  onSubmit: (
    e: FormEvent<HTMLFormElement>,
    capture?: { photoDataUrl: string; sha256Hash: string; meta: HavaPhotoMetadata },
    noPhotographicEvidence?: boolean,
  ) => void
  isSubmitting?: boolean
  errorMessage?: string | null
}) {
  const [condition, setCondition] = useState<'Damaged' | 'Missing'>('Damaged')
  const [noPhotoEvidence, setNoPhotoEvidence] = useState(false)
  const [captures, setCaptures] = useState<
    { photoDataUrl: string; sha256Hash: string; meta: HavaPhotoMetadata }[]
  >([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [cameraModalOpen, setCameraModalOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const latestCapture = captures[captures.length - 1]
  const photoCount = captures.length
  const photoRequired = condition === 'Damaged' && !noPhotoEvidence

  const handleInSystemCapture = (evidence: CapturedEvidence) => {
    setCaptures((prev) => [
      ...prev,
      {
        sha256Hash: evidence.sha256Hash,
        meta: evidence.meta,
        photoDataUrl: evidence.photoDataUrl,
      },
    ])
    setNoPhotoEvidence(false)
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setIsProcessing(true)
    try {
      const buffer = await file.arrayBuffer()
      const [sha256Hash, meta] = await Promise.all([computePhotoSha256(buffer), extractPhotoMetadata(file)])
      const photoDataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = (ev) => resolve(ev.target?.result as string)
        reader.readAsDataURL(file)
      })
      setCaptures((prev) => [...prev, { sha256Hash, meta, photoDataUrl }])
      setNoPhotoEvidence(false)
    } catch (err) {
      console.warn('[HAVA] Failed to process photo:', err)
    } finally {
      setIsProcessing(false)
      e.target.value = ''
    }
  }

  return (
    <form onSubmit={(e) => onSubmit(e, latestCapture, noPhotoEvidence)} className="space-y-4">
      <div>
        <p className="text-[0.68rem] font-bold uppercase tracking-wider text-muted-foreground">{phase} Validation</p>
        <p className="text-xs text-muted-foreground">{item.name} • {event}</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-hidden
        onChange={handleFileSelect}
      />

      <label className="block text-xs font-semibold text-foreground">
        Condition Type
        <select
          name="condition"
          value={condition}
          onChange={(e) => {
            setCondition(e.target.value as 'Damaged' | 'Missing')
            setCaptures([])
            setNoPhotoEvidence(false)
          }}
          className="mt-1 w-full rounded-xl border border-input bg-background p-3 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="Damaged">Damaged</option>
          <option value="Missing">Missing</option>
        </select>
      </label>

      {/* Exceptional No-Photo Checkbox */}
      {condition === 'Damaged' && (
        <div className="flex items-start gap-2.5 rounded-xl border border-border/80 bg-muted/30 p-3">
          <input
            type="checkbox"
            id="no-photo-toggle"
            checked={noPhotoEvidence}
            onChange={(e) => {
              setNoPhotoEvidence(e.target.checked)
              if (e.target.checked) setCaptures([])
            }}
            className="mt-0.5 size-4 rounded border-input text-primary focus:ring-ring"
          />
          <label htmlFor="no-photo-toggle" className="text-xs text-foreground cursor-pointer select-none">
            <span className="font-semibold block">No photographic evidence available (exceptional field path)</span>
            <span className="text-[0.62rem] text-muted-foreground block mt-0.5">
              Use only when physical obstruction or device limitation prevents on-site photography.
            </span>
          </label>
        </div>
      )}

      <input type="hidden" name="photoCaptured" value={photoCount > 0 ? '1' : ''} />

      {!noPhotoEvidence && (
        <div className="space-y-2">
          <div className="flex flex-col gap-0.5">
            <label className="block text-xs font-semibold text-foreground">
              {photoRequired ? 'Condition Evidence Photo (Required for damage)' : 'Condition Photo (Optional for missing items)'}
            </label>
            <p className="text-[0.62rem] text-muted-foreground leading-normal">
              Bulk asset condition evidence: 1 or more condition photos establish physical condition. Damaged quantity is declared below; individual photos of undamaged units are not required.
            </p>
          </div>

          {photoCount > 0 ? (
            <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-3 text-xs">
              {latestCapture?.photoDataUrl && (
                <img
                  src={latestCapture.photoDataUrl}
                  alt="Damage condition evidence preview"
                  className="h-28 w-full rounded-lg object-cover border border-border"
                />
              )}
              <div className="flex items-center justify-between">
                <span className="flex size-6 items-center justify-center rounded bg-primary font-bold text-primary-foreground text-[0.65rem]">
                  {photoCount}
                </span>
                <button
                  type="button"
                  onClick={() => setCameraModalOpen(true)}
                  disabled={isProcessing || isSubmitting}
                  className="text-xs font-semibold text-primary underline hover:opacity-80"
                >
                  + In-System Camera Capture
                </button>
              </div>
              <div className="rounded-lg bg-background p-2 font-mono text-[0.6rem] text-muted-foreground border border-border space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-foreground">Transport SHA-256 Digest:</span>
                  <span className="text-[0.55rem] uppercase text-muted-foreground">Byte Integrity Checksum</span>
                </div>
                <div className="break-all">{latestCapture?.sha256Hash}</div>
                <div className="flex items-center gap-1.5 pt-0.5 text-[0.55rem] text-muted-foreground">
                  <MapPin className="size-3 text-primary shrink-0" />
                  <span>GPS: {latestCapture?.meta.gpsCoordinates || 'Acquiring...'}</span>
                </div>
                <p className="text-[0.55rem] text-muted-foreground normal-case font-sans pt-0.5">
                  Client transport checksum only; backend independently inspects bytes for temporal validity and metadata.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <PwaButton
                type="button"
                onClick={() => setCameraModalOpen(true)}
                disabled={isProcessing || isSubmitting}
                variant="primary"
                size="md"
                icon={<Camera className="size-4" />}
                className="w-full shadow-md"
              >
                {isProcessing ? 'Processing photo...' : 'Open In-System Forensic Camera'}
              </PwaButton>
              <div className="flex items-center justify-between px-1 text-[0.58rem] text-muted-foreground">
                <span>In-System camera acquisition</span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="underline hover:text-foreground"
                >
                  Device Capture Fallback
                </button>
              </div>
            </div>
          )}

          <HavaCameraCaptureModal
            isOpen={cameraModalOpen}
            onClose={() => setCameraModalOpen(false)}
            onCaptureComplete={handleInSystemCapture}
            itemName={item.name}
            eventName={event}
          />
        </div>
      )}

      <div className="space-y-1">
        <label className="block text-xs font-semibold text-foreground">
          Accountability Quantity (Units Affected)
        </label>
        <p className="text-[0.62rem] text-muted-foreground leading-normal">
          Declare the exact numeric count of damaged or missing units in this batch.
        </p>
        <input
          name="quantity"
          type="number"
          min="1"
          defaultValue="1"
          disabled={isSubmitting}
          className="w-full rounded-xl border border-input bg-background p-3 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <label className="block text-xs font-semibold text-foreground">
        Damage Description
        <textarea
          name="description"
          required
          rows={3}
          disabled={isSubmitting}
          placeholder="Describe item condition or missing count details..."
          className="mt-1 w-full rounded-xl border border-input bg-background p-3 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      {errorMessage && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
          {errorMessage}
        </div>
      )}

      <PwaButton type="submit" disabled={isProcessing || isSubmitting} variant="primary" size="md" className="w-full">
        {isSubmitting ? 'Submitting report to server...' : 'Submit Validation Report'}
      </PwaButton>
    </form>
  )
}

type ScheduleShift = {
  assignment: MyManningAssignmentDto
  event: EventItem
  stages: string[]
}

const SCHEDULE_STAGES = ['Ingress · Venue Arrival', 'Egress · Warehouse Return'] as const

function manilaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
}

function stagesForCrewScope(_scope: 'Warehouse Crew' | 'Field Crew') {
  return ['Ingress · Venue Arrival', 'Egress · Warehouse Return']
}

function formatTime(value?: string | null) {
  if (!value) return null
  const match = value.match(/(\d{1,2}):(\d{2})/)
  if (!match) return value
  const hour = Number(match[1])
  const suffix = hour >= 12 ? 'PM' : 'AM'
  return `${hour % 12 || 12}:${match[2]} ${suffix}`
}

const SCHEDULE_PREVIEW_ASSIGNMENT = {
  ...HOME_PREVIEW_ASSIGNMENT,
  assignmentId: 'schedule-preview-assignment',
  taskTitle: 'Venue arrival verification',
  workArea: 'Field',
  assignedRole: 'Field Crew',
  isLead: true,
} as MyManningAssignmentDto

const SCHEDULE_PREVIEW_EVENT: EventItem = {
  ...HOME_PREVIEW_EVENT,
  id: 'schedule-preview-event',
  name: 'Lumière Live Operational Demonstration',
  phase: 'Venue Arrival',
}

void EventDetail

function CalendarView({
  selectedDate,
  setSelectedDate,
  assignments,
  events,
  loading,
  error,
  isLeadForEvent,
  crewScope,
}: {
  selectedDate: string
  setSelectedDate: (date: string) => void
  assignments: MyManningAssignmentDto[]
  events: EventItem[]
  loading: boolean
  error: string | null
  isLeadForEvent: (eventId: string) => boolean
  crewScope: 'Warehouse Crew' | 'Field Crew'
}) {
  const today = manilaToday()
  const [view, setView] = useState(() => {
    const [year, month] = selectedDate.split('-').map(Number)
    return { year, month: month - 1 }
  })
  const [detail, setDetail] = useState<ScheduleShift | null>(null)
  const previewMode = assignments.length === 0 && events.length === 0
  const displayAssignments = previewMode ? [SCHEDULE_PREVIEW_ASSIGNMENT] : assignments
  const displayEvents = previewMode ? [SCHEDULE_PREVIEW_EVENT] : events
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const shifts: ScheduleShift[] = displayAssignments.filter((a) => Boolean(a.shiftDate)).map((assignment) => {
    const event = displayEvents.find((item) => item.id === assignment.eventId) ?? { id: assignment.eventId, name: assignment.eventName || 'Event', date: assignment.shiftDate!.slice(0, 10), venue: '', status: 'Upcoming' as EventStatus, editable: false, phase: null, items: [] }
    return { assignment, event: { ...event, date: assignment.shiftDate!.slice(0, 10) }, stages: stagesForCrewScope(crewScope) }
  })
  const selected = shifts.filter((shift) => shift.event.date === selectedDate)
  const recent = shifts.filter((shift) => shift.event.date < today).sort((a, b) => b.event.date.localeCompare(a.event.date)).slice(0, 5)
  const firstWeekday = new Date(view.year, view.month, 1).getDay()
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate()
  const monthDays = Array.from({ length: daysInMonth }, (_, index) => index + 1)
  const shiftMonth = (delta: number) => setView((current) => { const next = new Date(current.year, current.month + delta, 1); return { year: next.getFullYear(), month: next.getMonth() } })
  const tagFor = (date: string) => date === today ? 'Today' : date > today ? 'Upcoming' : 'Past'
  const card = (shift: ScheduleShift) => {
    const assignment = shift.assignment
    return (
      <button key={assignment.assignmentId} type="button" onClick={() => setDetail(shift)} className="w-full rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent/30">
        <div className="flex items-start justify-between gap-2">
          <div><h3 className="font-serif text-sm font-bold text-foreground">{shift.event.name}</h3><p className="mt-0.5 text-xs text-muted-foreground">{shift.event.venue || 'Venue not provided'}</p></div>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <PwaBadge variant="neutral" label={tagFor(shift.event.date)} />
            {isLeadForEvent(assignment.eventId) && <PwaBadge variant="subrole" subRole="Field" label="Team Lead" />}
          </div>
        </div>
        {formatTime(assignment.shiftStartTime) && <p className="mt-2 text-xs text-muted-foreground"><Clock className="mr-1 inline size-3" />Call time {formatTime(assignment.shiftStartTime)}</p>}
      </button>
    )
  }
  if (detail) return <ScheduleDetail shift={detail} today={today} isLead={isLeadForEvent(detail.event.id)} onBack={() => setDetail(null)} />
  if (loading) return <div className="space-y-3" aria-label="Loading schedule"><div className="h-48 animate-pulse rounded-2xl bg-muted" /><div className="h-28 animate-pulse rounded-2xl bg-muted" /></div>
  if (error && shifts.length === 0) return <PwaEmptyState title="Couldn't load your schedule. Try again." description="" />
  return (
  <div className="space-y-3">
  {previewMode && <div className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">Preview schedule data is shown because this account has no active assignments yet.</div>}
  <PwaCard>
        <div className="mb-1 flex items-center justify-between"><button type="button" aria-label="Previous month" onClick={() => shiftMonth(-1)} className="rounded-full p-1.5 hover:bg-accent"><ChevronLeft className="size-4" /></button><h2 className="font-serif text-base font-bold">{monthNames[view.month]} {view.year}</h2><button type="button" aria-label="Next month" onClick={() => shiftMonth(1)} className="rounded-full p-1.5 hover:bg-accent"><ChevronRight className="size-4" /></button></div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-[0.6rem] text-muted-foreground">{['S','M','T','W','T','F','S'].map((day, index) => <span key={`${day}-${index}`} className="py-0.5 font-bold">{day}</span>)}{Array.from({ length: firstWeekday }, (_, index) => <span key={`pad-${index}`} />)}{monthDays.map((day) => { const date = `${view.year}-${String(view.month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; const hasShift = shifts.some((shift) => shift.event.date === date); const past = date < today; const isToday = date === today; const isSelected = date === selectedDate; return <button type="button" key={date} onClick={() => setSelectedDate(date)} className={`relative flex min-h-7 flex-col items-center justify-center rounded-lg text-xs ${isSelected ? 'ring-2 ring-primary' : ''} ${isToday ? 'bg-primary text-primary-foreground font-bold' : 'text-foreground'}`}><span>{day}</span>{hasShift && <span className={`mt-0.5 size-1.5 rounded-full ${past ? 'bg-muted-foreground/50' : isToday ? 'bg-primary-foreground' : 'bg-primary'}`} />}</button>})}</div>
      </PwaCard>
      <section aria-labelledby="selected-shifts-heading"><h2 id="selected-shifts-heading" className="mb-2 font-serif text-base font-bold">{selectedDate === today ? `Today · ${dateLabel(selectedDate)}` : dateLabel(selectedDate)}</h2>{selected.length ? <div className="space-y-2">{selected.map(card)}</div> : <div className="rounded-2xl border border-border bg-muted/30 p-4 text-sm text-muted-foreground">{selectedDate === today ? 'Not rostered today' : 'Not rostered on this day'}</div>}</section>
      {recent.length > 0 && <section aria-labelledby="recent-shifts-heading"><h2 id="recent-shifts-heading" className="mb-2 font-serif text-base font-bold">Recent shifts</h2><div className="space-y-2">{recent.map(card)}</div></section>}
    </div>
  )
}

function ScheduleDetail({ shift, today, isLead, onBack }: { shift: ScheduleShift; today: string; isLead: boolean; onBack: () => void }) {
  const { assignment, event, stages } = shift
  const completed = assignment.executionStatus === 'Completed'
  return <div className="space-y-4"><button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm font-semibold text-primary"><ChevronLeft className="size-4" />Back</button><PwaCard><div className="flex items-start justify-between gap-2"><div><h1 className="font-serif text-xl font-bold">{event.name}</h1><p className="mt-1 text-sm text-muted-foreground">{event.venue || 'Venue not provided'}</p></div>{isLead && <PwaBadge variant="subrole" subRole="Field" label="Team Lead" />}</div><div className="mt-4 space-y-2 text-sm"><p>{stages[0]}: {dateLabel(event.date)}{formatTime(assignment.shiftStartTime) ? ` · ${formatTime(assignment.shiftStartTime)}` : ''}</p>{formatTime(assignment.shiftStartTime) && <p>Call time: {formatTime(assignment.shiftStartTime)}</p>}{formatTime(assignment.shiftEndTime) && <p>Event hours end: {formatTime(assignment.shiftEndTime)}</p>}{completed && <p className="font-semibold text-primary">Completed</p>}{!completed && event.date < today && <p className="text-muted-foreground">Past</p>}</div><div className="mt-5 space-y-2">{SCHEDULE_STAGES.map((stage) => <div key={stage} className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm"><span>{stage}</span></div>)}</div></PwaCard></div>
}

void Activity

function Activity({
  reports,
  requests,
  events,
  offlineItems = [],
  isSyncingQueue = false,
  onTriggerSync,
  onUpdateReport,
}: {
  reports: DamageReport[]
  requests: CrewRequest[]
  events: EventItem[]
  offlineItems?: QueuedDeclaration[]
  isSyncingQueue?: boolean
  onTriggerSync?: () => void
  onUpdateReport?: (
    reportId: string,
    updates: { quantity: number; description?: string; condition?: 'Damaged' | 'Missing'; expectedVersion: number },
  ) => Promise<{ success: boolean; error?: string; code?: string }>
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editQty, setEditQty] = useState<number>(1)
  const [editDesc, setEditDesc] = useState<string>('')
  const [editCond, setEditCond] = useState<'Damaged' | 'Missing'>('Damaged')
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const startEdit = (r: DamageReport) => {
    setEditingId(r.id)
    setEditQty(r.quantity)
    setEditDesc(r.description || '')
    setEditCond(r.condition || 'Damaged')
    setEditError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditError(null)
  }

  const saveEdit = async (r: DamageReport) => {
    if (!onUpdateReport) return
    setIsSavingEdit(true)
    setEditError(null)
    try {
      const res = await onUpdateReport(r.id, {
        quantity: editQty,
        description: editDesc,
        condition: editCond,
        expectedVersion: r.version ?? 1,
      })
      if (res.success) {
        setEditingId(null)
      } else {
        if (res.code === 'DECLARATION_FINALIZED') {
          setEditError('Declaration review window expired on server. Record is now finalized and cannot be edited directly.')
        } else if (res.code === 'STALE_VERSION') {
          setEditError('Version conflict: The declaration was modified in another session. Please review current values.')
        } else {
          setEditError(res.error || 'Failed to update declaration.')
        }
      }
    } catch (err: any) {
      setEditError(err?.message || 'Error saving corrections')
    } finally {
      setIsSavingEdit(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Offline Sync Queue */}
      {offlineItems.length > 0 && (
        <PwaCard
          title="Offline Sync Queue"
          subtitle={`${offlineItems.length} declaration(s) queued locally`}
          action={
            <button
              type="button"
              onClick={onTriggerSync}
              disabled={isSyncingQueue}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/20 transition disabled:opacity-50"
            >
              <RefreshCw className={`size-3 ${isSyncingQueue ? 'animate-spin' : ''}`} />
              {isSyncingQueue ? 'Syncing...' : 'Sync Now'}
            </button>
          }
        >
          <div className="space-y-2 pt-1">
            {offlineItems.map((item) => (
              <div key={item.id} className="rounded-xl border border-border bg-muted/30 p-3 text-xs space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-bold text-foreground">{item.itemName}</span>
                  {item.syncStatus === 'syncing' ? (
                    <StatusBadge variant="info" icon={<RefreshCw className="size-3 animate-spin" />}>
                      Syncing...
                    </StatusBadge>
                  ) : item.syncStatus === 'server rejected/conflicted' ? (
                    <StatusBadge variant="destructive" icon={<AlertCircle className="size-3" />}>
                      Server Rejected / Conflict
                    </StatusBadge>
                  ) : (
                    <StatusBadge variant="warning" icon={<Clock className="size-3" />}>
                      Locally Queued
                    </StatusBadge>
                  )}
                </div>
                <p className="text-muted-foreground">{item.eventName} • {item.condition}</p>
                <p className="text-foreground">{item.quantity} unit(s) declared • {item.description}</p>
                <div className="flex items-center justify-between text-[0.6rem] text-muted-foreground font-mono">
                  <span>ID: {item.id}</span>
                  <span className="truncate max-w-[150px]">Key: {item.idempotencyKey.slice(0, 8)}...</span>
                </div>
                {item.lastError && (
                  <div className="rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 p-2 text-[0.65rem] text-rose-800 dark:text-rose-300">
                    <span className="font-semibold">Rejection reason: </span>
                    {item.lastError}
                  </div>
                )}
              </div>
            ))}
          </div>
        </PwaCard>
      )}

      {/* Authoritative Condition Declarations */}
      <PwaCard title="Authoritative Condition Declarations">
        {reports.length === 0 ? (
          <PwaEmptyState title="No Reports" description="You have not submitted any damage or condition reports." />
        ) : (
          <div className="space-y-3 pt-1">
            {reports.map((r) => {
              const isReviewable = r.declarationState === 'Reviewable'
              const isEditing = editingId === r.id
              const isEditable = r.isEditable !== false && isReviewable

              return (
                <div key={r.id} className="rounded-xl border border-border p-3 text-xs space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-1.5">
                    <div className="min-w-0">
                      <h4 className="font-bold text-foreground truncate">{r.item}</h4>
                      <p className="text-[0.68rem] text-muted-foreground">{r.event} • {r.phase}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* Declaration State Badge */}
                      {isReviewable ? (
                        <StatusBadge variant="info" icon={<Clock className="size-3" />}>
                          Reviewable (Provisional)
                        </StatusBadge>
                      ) : (
                        <StatusBadge variant="neutral" icon={<CheckCircle2 className="size-3" />}>
                          Finalized
                        </StatusBadge>
                      )}

                      {/* Temporal Evidence Badge */}
                      {r.evidenceStatus === 'Temporally Valid' || r.evidenceStatus === 'Valid' ? (
                        <StatusBadge variant="success" icon={<ShieldCheck className="size-3" />}>
                          Temporally Valid
                        </StatusBadge>
                      ) : r.evidenceStatus === 'Temporally Invalid' ? (
                        <StatusBadge variant="destructive" icon={<AlertCircle className="size-3" />}>
                          Temporally Invalid
                        </StatusBadge>
                      ) : r.evidenceStatus === 'Processing Evidence' ? (
                        <StatusBadge variant="info" icon={<RefreshCw className="size-3 animate-spin" />}>
                          Processing Evidence
                        </StatusBadge>
                      ) : r.evidenceStatus === 'Held for Audit' ? (
                        <StatusBadge variant="warning" icon={<AlertTriangle className="size-3" />}>
                          Held for Audit
                        </StatusBadge>
                      ) : r.evidenceStatus === 'No Photographic Evidence' ? (
                        <StatusBadge variant="warning" icon={<AlertTriangle className="size-3" />}>
                          No Photo Evidence
                        </StatusBadge>
                      ) : (
                        <StatusBadge variant="warning" icon={<AlertTriangle className="size-3" />}>
                          Unverifiable Evidence
                        </StatusBadge>
                      )}

                      {/* Offline sync status if applicable */}
                      {r.offlineSyncStatus === 'locally queued' && (
                        <StatusBadge variant="warning">Locally Queued</StatusBadge>
                      )}
                      {r.offlineSyncStatus === 'server rejected/conflicted' && (
                        <StatusBadge variant="destructive">Conflict</StatusBadge>
                      )}
                    </div>
                  </div>

                  {!isEditing ? (
                    <>
                      <p className="text-foreground">
                        <span className="font-semibold">{r.quantity} unit(s)</span> affected ({r.condition || 'Damaged'}) • {r.description}
                      </p>
                      <p className="text-[0.65rem] text-muted-foreground pt-0.5">
                        {r.capturedAt} • {r.location}
                        {r.version ? ` • v${r.version}` : ''}
                      </p>

                      {/* Review Window Banner */}
                      {isReviewable && (
                        <div className="rounded-lg bg-sky-50 dark:bg-sky-950/40 p-2.5 border border-sky-200 dark:border-sky-800 text-[0.65rem] text-sky-900 dark:text-sky-200 space-y-1">
                          <div className="flex items-center justify-between font-semibold">
                            <span className="flex items-center gap-1.5">
                              <Clock className="size-3 text-sky-600 dark:text-sky-400" />
                              Declaration Review Window Active
                            </span>
                            {r.reviewDeadlineAt && (
                              <span className="font-mono text-[0.6rem]">
                                Closes {new Date(r.reviewDeadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            )}
                          </div>
                          <p className="text-muted-foreground text-[0.62rem]">
                            Saved on server. Corrections permitted during the review window before authoritative finalization.
                          </p>
                        </div>
                      )}

                      {/* Edit Button during Review Window */}
                      {isEditable && onUpdateReport && (
                        <div className="pt-1 flex items-center justify-end">
                          <button
                            type="button"
                            onClick={() => startEdit(r)}
                            className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[0.65rem] font-semibold text-primary hover:bg-muted transition"
                          >
                            <Edit3 className="size-3" />
                            Edit Declaration
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    /* Inline Editing Form */
                    <div className="mt-2 space-y-3 rounded-lg border border-primary/30 bg-muted/20 p-3">
                      <div className="flex items-center justify-between text-[0.68rem] font-semibold text-primary">
                        <span>Edit Reviewable Declaration</span>
                        <span className="font-mono text-[0.6rem] text-muted-foreground">Version {r.version ?? 1}</span>
                      </div>

                      {editError && (
                        <div className="rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 p-2 text-[0.65rem] text-rose-800 dark:text-rose-300">
                          {editError}
                        </div>
                      )}

                      <div className="space-y-1">
                        <label className="block text-[0.65rem] font-semibold text-foreground">
                          Accountability Quantity
                        </label>
                        <input
                          type="number"
                          min="1"
                          max="10000"
                          value={editQty}
                          onChange={(e) => setEditQty(Math.max(1, Number(e.target.value) || 1))}
                          disabled={isSavingEdit}
                          className="w-full rounded-lg border border-input bg-background p-2 text-xs focus:ring-1 focus:ring-primary"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="block text-[0.65rem] font-semibold text-foreground">
                          Condition
                        </label>
                        <select
                          value={editCond}
                          onChange={(e) => setEditCond(e.target.value as 'Damaged' | 'Missing')}
                          disabled={isSavingEdit}
                          className="w-full rounded-lg border border-input bg-background p-2 text-xs focus:ring-1 focus:ring-primary"
                        >
                          <option value="Damaged">Damaged</option>
                          <option value="Missing">Missing</option>
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="block text-[0.65rem] font-semibold text-foreground">
                          Description
                        </label>
                        <textarea
                          rows={2}
                          value={editDesc}
                          onChange={(e) => setEditDesc(e.target.value)}
                          disabled={isSavingEdit}
                          className="w-full rounded-lg border border-input bg-background p-2 text-xs focus:ring-1 focus:ring-primary"
                        />
                      </div>

                      <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={isSavingEdit}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => saveEdit(r)}
                          disabled={isSavingEdit}
                          className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                          {isSavingEdit ? (
                            <>
                              <RefreshCw className="size-3 animate-spin" /> Saving...
                            </>
                          ) : (
                            'Save Corrections'
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </PwaCard>

      <PwaCard title="Workforce Requests">
        {requests.length === 0 ? (
          <PwaEmptyState
            title="No Requests"
            description="No workforce requests on record. Contact your Workforce Admin to submit leave or schedule requests."
          />
        ) : (
          requests.map((q) => (
            <div key={q.id} className="flex items-center justify-between border-b border-border/60 py-2.5 text-xs">
              <div>
                <p className="font-bold text-foreground">{q.type}</p>
                <p className="text-muted-foreground">{dateLabel(q.date)} • {q.note}</p>
              </div>
              <PwaBadge
                variant={q.status === 'Approved' ? 'subrole' : q.status === 'Denied' ? 'destructive' : 'neutral'}
                label={q.status}
              />
            </div>
          ))
        )}
      </PwaCard>

      <PwaCard title="Completed Events">
        {events.filter((e) => e.status === 'Completed').length === 0 ? (
          <PwaEmptyState
            title="No Completed Events"
            description="Completed events and closed-out shifts will appear here after close-out."
          />
        ) : (
          events.filter((e) => e.status === 'Completed').map((e) => (
            <div key={e.id} className="py-2 text-xs">
              <p className="font-bold text-foreground">{e.name}</p>
              <p className="text-muted-foreground">{dateLabel(e.date)} • Completed</p>
            </div>
          ))
        )}
      </PwaCard>
    </div>
  )
}

void DecisionMode

function Account({
  name,
  email,
  accessLevel,
  effectiveRole,
  onLogout,
}: {
  name: string
  email: string
  accessLevel: AccessLevel
  effectiveRole: string
  onLogout: () => void
}) {
  return (
    <div className="space-y-4">
      <PwaCard title={name} subtitle={email} action={<PwaBadge subRole="Field" label="Active Operator" />}>
        <span className="sr-only">Profile</span>
      </PwaCard>

      <PwaCard title="Access & Authority">
        <div className="space-y-2 text-xs text-muted-foreground"><div className="flex items-center justify-between"><span>Assigned role</span><strong className="text-foreground">{effectiveRole}</strong></div><div className="flex items-center justify-between"><span>Access tier</span><strong className="text-foreground">{accessLevel}</strong></div><p className="pt-1 leading-relaxed">Authority is determined by your authenticated account and event assignments.</p></div>
      </PwaCard>

      <PwaCard title="Operator Actions">
        <div className="space-y-2">
          <PwaButton onClick={onLogout} variant="destructive" size="md" className="w-full">
            Sign Out
          </PwaButton>
        </div>
      </PwaCard>
    </div>
  )
}

function RequestForm({
  type,
  setType,
  date,
  setDate,
  note,
  setNote,
  onSubmit,
}: {
  type: string
  setType: (val: string) => void
  date: string
  setDate: (val: string) => void
  note: string
  setNote: (val: string) => void
  onSubmit: (e: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block text-xs font-semibold text-foreground">
        Request Type
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="mt-1 w-full rounded-xl border border-input bg-background p-3 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option>Sick leave</option>
          <option>Personal leave</option>
          <option>Schedule request</option>
          <option>Other request</option>
        </select>
      </label>

      <label className="block text-xs font-semibold text-foreground">
        Target Date
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mt-1 w-full rounded-xl border border-input bg-background p-3 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      <label className="block text-xs font-semibold text-foreground">
        Details
        <textarea
          required
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Specify details for admin review..."
          className="mt-1 w-full rounded-xl border border-input bg-background p-3 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      <PwaButton type="submit" variant="primary" size="md" icon={<Send className="size-4" />} className="w-full">
        Send Request
      </PwaButton>
    </form>
  )
}
