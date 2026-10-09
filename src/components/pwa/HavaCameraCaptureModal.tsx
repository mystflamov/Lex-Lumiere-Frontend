import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Camera,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  X,
  MapPin,
  ShieldCheck,
  RotateCcw,
  Zap,
} from 'lucide-react'
import { computePhotoSha256, formatGpsDisplay, type HavaPhotoMetadata } from '@/lib/hava'

export interface CapturedEvidence {
  photoDataUrl: string
  sha256Hash: string
  meta: HavaPhotoMetadata
  file: File
}

interface HavaCameraCaptureModalProps {
  isOpen: boolean
  onClose: () => void
  onCaptureComplete: (evidence: CapturedEvidence) => void
  itemName?: string
  eventName?: string
}

type CameraState =
  | 'requesting'
  | 'ready'
  | 'capturing'
  | 'preview'
  | 'permission_denied'
  | 'unsupported'

type GpsState =
  | 'acquiring'
  | 'acquired'
  | 'denied'
  | 'unavailable'

export function HavaCameraCaptureModal({
  isOpen,
  onClose,
  onCaptureComplete,
  itemName = 'Asset Item',
  eventName = 'Active Event',
}: HavaCameraCaptureModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [cameraState, setCameraState] = useState<CameraState>('requesting')
  const [gpsState, setGpsState] = useState<GpsState>('acquiring')
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lon: number } | null>(null)
  const [gpsErrorMessage, setGpsErrorMessage] = useState<string | null>(null)
  const [cameraErrorMessage, setCameraErrorMessage] = useState<string | null>(null)

  const [previewEvidence, setPreviewEvidence] = useState<CapturedEvidence | null>(null)

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {}
      })
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  const startCamera = useCallback(async () => {
    stopStream()
    setCameraState('requesting')
    setCameraErrorMessage(null)

    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraState('unsupported')
      setCameraErrorMessage('Live camera access is unavailable here. You can still choose a photo from the device camera or gallery.')
      return
    }

    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => {})
      }

      setCameraState('ready')
    } catch (err: any) {
      console.warn('[HavaCamera] Camera access failed:', err)
      const isDenied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'
      setCameraState(isDenied ? 'permission_denied' : 'unsupported')
      setCameraErrorMessage(
        isDenied
          ? 'Camera access permission was denied. Enable camera access in your browser settings.'
          : err.message || 'Unable to open video camera stream.'
      )
    }
  }, [stopStream])

  // Acquire Geolocation
  const acquireGps = useCallback(() => {
    setGpsState('acquiring')
    setGpsCoords(null)
    setGpsErrorMessage(null)

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsState('unavailable')
      setGpsErrorMessage('Geolocation not supported by device.')
      return
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude })
        setGpsState('acquired')
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setGpsState('denied')
          setGpsErrorMessage('GPS permission denied')
        } else {
          setGpsState('unavailable')
          setGpsErrorMessage('GPS signal unavailable')
        }
      },
      { timeout: 8000, maximumAge: 30000, enableHighAccuracy: true }
    )
  }, [])

  useEffect(() => {
    if (isOpen) {
      setPreviewEvidence(null)
      startCamera()
      acquireGps()
    } else {
      stopStream()
    }

    return () => {
      stopStream()
    }
  }, [isOpen, startCamera, acquireGps, stopStream])

  // Shutter trigger
  const handleShutter = async () => {
    if (!videoRef.current || cameraState !== 'ready') return
    setCameraState('capturing')

    try {
      const video = videoRef.current
      const width = video.videoWidth || 1280
      const height = video.videoHeight || 720

      const canvas = canvasRef.current || document.createElement('canvas')
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D context unavailable')

      ctx.drawImage(video, 0, 0, width, height)

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9)
      )

      if (!blob) throw new Error('Failed to encode camera frame into image blob')

      const capturedAt = new Date().toISOString()
      const filename = `hava_evidence_${Date.now()}.jpg`
      const file = new File([blob], filename, { type: 'image/jpeg', lastModified: Date.now() })

      const buffer = await blob.arrayBuffer()
      const sha256Hash = await computePhotoSha256(buffer)

      const photoDataUrl = canvas.toDataURL('image/jpeg', 0.9)

      const gpsCoordinates =
        gpsCoords !== null
          ? formatGpsDisplay(gpsCoords.lat, gpsCoords.lon)
          : gpsState === 'denied'
          ? 'GPS permission denied'
          : 'GPS unavailable'

      const meta: HavaPhotoMetadata = {
        capturedAt,
        gpsCoordinates,
        latitude: gpsCoords?.lat ?? null,
        longitude: gpsCoords?.lon ?? null,
        gpsSource: gpsCoords !== null ? 'geolocation' : 'unavailable',
        exifJson: JSON.stringify({
          source: 'in-system-camera',
          resolution: `${width}x${height}`,
          capturedAt,
        }),
      }

      const evidence: CapturedEvidence = {
        photoDataUrl,
        sha256Hash,
        meta,
        file,
      }

      setPreviewEvidence(evidence)
      setCameraState('preview')
      stopStream()
    } catch (err: any) {
      console.error('[HavaCamera] Capture error:', err)
      setCameraErrorMessage(err.message || 'Failed to capture frame.')
      setCameraState('ready')
    }
  }

  const handleFileCapture = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const buffer = await file.arrayBuffer()
      const sha256Hash = await computePhotoSha256(buffer)
      const photoDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('Unable to read selected photo.'))
        reader.readAsDataURL(file)
      })
      const capturedAt = new Date().toISOString()
      setPreviewEvidence({
        photoDataUrl,
        sha256Hash,
        meta: {
          capturedAt,
          gpsCoordinates: gpsCoords ? formatGpsDisplay(gpsCoords.lat, gpsCoords.lon) : 'GPS unavailable',
          latitude: gpsCoords?.lat ?? null,
          longitude: gpsCoords?.lon ?? null,
          gpsSource: gpsCoords ? 'geolocation' : 'unavailable',
          exifJson: JSON.stringify({ source: 'device-photo', capturedAt }),
        },
        file,
      })
      stopStream()
      setCameraState('preview')
    } catch (error) {
      setCameraErrorMessage(error instanceof Error ? error.message : 'Unable to use selected photo.')
      setCameraState('unsupported')
    }
  }

  const handleRetake = () => {
    setPreviewEvidence(null)
    startCamera()
  }

  const handleConfirm = () => {
    if (!previewEvidence) return
    onCaptureComplete(previewEvidence)
    onClose()
  }

  if (!isOpen) return null

  return (
    <>
    <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handleFileCapture} className="sr-only" aria-label="Choose evidence photo" />
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-3 sm:p-4">
      <div className="relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border/80 bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Camera className="size-4" />
            </div>
            <div>
              <h2 className="text-xs font-bold uppercase tracking-wider text-foreground">
                In-System Forensic Camera
              </h2>
              <p className="text-[0.62rem] text-muted-foreground truncate max-w-[240px]">
                {itemName} • {eventName}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Camera"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Viewfinder / Viewport Area */}
        <div className="relative aspect-[4/3] w-full bg-black overflow-hidden flex items-center justify-center">
          {/* Live Video Viewfinder */}
          {cameraState === 'ready' && (
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover"
            />
          )}

          {/* Captured Preview */}
          {cameraState === 'preview' && previewEvidence && (
            <img
              src={previewEvidence.photoDataUrl}
              alt="Captured evidence preview"
              className="h-full w-full object-cover"
            />
          )}

          {/* Hidden Canvas for Frame Extraction */}
          <canvas ref={canvasRef} className="hidden" />

          {/* State Overlays */}
          {cameraState === 'requesting' && (
            <div className="flex flex-col items-center gap-2 text-white p-6 text-center">
              <RefreshCw className="size-8 animate-spin text-primary" />
              <p className="text-xs font-bold uppercase tracking-wider">Accessing Device Camera...</p>
              <p className="text-[0.65rem] text-muted-foreground">Requesting live hardware video stream</p>
            </div>
          )}

          {cameraState === 'permission_denied' && (
            <div className="flex flex-col items-center gap-2.5 text-white p-6 text-center max-w-xs">
              <div className="flex size-10 items-center justify-center rounded-full bg-destructive/20 text-destructive">
                <AlertTriangle className="size-6" />
              </div>
              <p className="text-xs font-bold uppercase tracking-wider text-destructive">Camera Permission Denied</p>
              <p className="text-[0.68rem] text-muted-foreground leading-relaxed">
                {cameraErrorMessage || 'Camera access was blocked by your browser or operating system settings.'}
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted transition"
              >
                <Camera className="size-3.5" />
                Use Device Camera
              </button>
              <button
                type="button"
                onClick={startCamera}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 transition"
              >
                <RefreshCw className="size-3.5" />
                Retry Camera Access
              </button>
            </div>
          )}

          {cameraState === 'unsupported' && (
            <div className="flex flex-col items-center gap-2 text-white p-6 text-center max-w-xs">
              <AlertTriangle className="size-7 text-amber-400" />
              <p className="text-xs font-bold uppercase tracking-wider text-amber-400">Direct Stream Unavailable</p>
              <p className="text-[0.65rem] text-muted-foreground">
                {cameraErrorMessage || 'MediaDevices camera stream is not supported in this browser environment.'}
              </p>
            </div>
          )}

          {/* Viewfinder Target Reticle */}
          {cameraState === 'ready' && (
            <div className="pointer-events-none absolute inset-6 flex items-center justify-center">
              <div className="relative size-36 border border-white/30 rounded-lg">
                <div className="absolute top-0 left-0 size-3 border-t-2 border-l-2 border-primary" />
                <div className="absolute top-0 right-0 size-3 border-t-2 border-r-2 border-primary" />
                <div className="absolute bottom-0 left-0 size-3 border-b-2 border-l-2 border-primary" />
                <div className="absolute bottom-0 right-0 size-3 border-b-2 border-r-2 border-primary" />
              </div>
            </div>
          )}

          {/* Live GPS Stamp Overlay */}
          <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-black/60 backdrop-blur-md px-2 py-1 text-[0.58rem] font-mono text-white/90 border border-white/10">
            <MapPin className="size-3 text-primary shrink-0" />
            <span>
              {gpsState === 'acquiring' && 'GPS Acquiring...'}
              {gpsState === 'acquired' && gpsCoords && formatGpsDisplay(gpsCoords.lat, gpsCoords.lon)}
              {gpsState === 'denied' && (gpsErrorMessage || 'GPS Denied')}
              {gpsState === 'unavailable' && (gpsErrorMessage || 'GPS Unavailable')}
            </span>
          </div>

          {/* Camera-Only Mode Badge */}
          <div className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-emerald-950/80 backdrop-blur-md px-2 py-1 text-[0.55rem] font-bold uppercase tracking-wider text-emerald-300 border border-emerald-500/30">
            <Zap className="size-2.5" />
            <span>In-System Capture</span>
          </div>
        </div>

        {/* Metadata & Controls Footer */}
        <div className="space-y-3 p-4 bg-card">
          {/* Platform Limitation Notice */}
          <div className="rounded-lg border border-border/80 bg-muted/30 p-2 text-[0.58rem] text-muted-foreground leading-tight space-y-0.5">
            <div className="flex items-center gap-1 font-semibold text-foreground">
              <ShieldCheck className="size-3 text-primary shrink-0" />
              <span>Application-Level Camera Workflow</span>
            </div>
            <p>
              Direct video stream acquisition captures evidence frames in-system without exposing standard gallery dialogs in modern browsers.
            </p>
          </div>

          {/* Capture Evidence Summary when Previewing */}
          {cameraState === 'preview' && previewEvidence && (
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between font-semibold text-foreground">
                <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-3.5" />
                  Frame Captured &amp; Digested
                </span>
                <span className="font-mono text-[0.6rem] text-muted-foreground">
                  {new Date(previewEvidence.meta.capturedAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="font-mono text-[0.58rem] text-muted-foreground break-all bg-background/80 p-1.5 rounded border border-border">
                <span className="font-bold text-foreground">Transport SHA-256: </span>
                {previewEvidence.sha256Hash}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-col gap-2">
            {cameraState !== 'preview' && <button type="button" onClick={() => fileInputRef.current?.click()} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-bold text-primary-foreground shadow-lg transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"><Camera className="size-5" aria-hidden="true" />Take Photo</button>}
            <div className="flex items-center gap-2">
            {cameraState === 'ready' && (
              <button
                type="button"
                onClick={handleShutter}
                className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-primary py-3 text-xs font-bold uppercase tracking-wider text-primary-foreground hover:opacity-90 transition shadow-lg"
              >
                <Camera className="size-4" />
                Capture Evidence Frame
              </button>
            )}

            {cameraState === 'preview' && (
              <>
                <button
                  type="button"
                  onClick={handleRetake}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-xl border border-border bg-background py-2.5 text-xs font-bold uppercase tracking-wider text-foreground hover:bg-muted transition"
                >
                  <RotateCcw className="size-3.5" />
                  Retake
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-primary py-2.5 text-xs font-bold uppercase tracking-wider text-primary-foreground hover:opacity-90 transition shadow-md"
                >
                  <CheckCircle2 className="size-3.5" />
                  Use Evidence
                </button>
              </>
            )}

            {cameraState !== 'ready' && cameraState !== 'preview' && (
              <button
                type="button"
                onClick={onClose}
                className="w-full rounded-xl border border-border bg-background py-2.5 text-xs font-semibold text-foreground hover:bg-muted transition"
              >
                Cancel
              </button>
            )}
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  )
}
