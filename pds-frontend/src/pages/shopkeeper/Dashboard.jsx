import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Box,
  Clock,
  MapPin,
  Package,
  QrCode,
  RefreshCw,
  Store,
  TrendingUp,
  Wifi,
  WifiOff,
  Zap,
  ChevronRight,
} from "lucide-react";
import api from "../../api/axios";
import Card from "../../components/ui/Card";
import Skeleton from "../../components/ui/Skeleton";
import Button from "../../components/ui/Button";
import Badge from "../../components/ui/Badge";
import ShopStatusCard from "../../components/shopkeeper/ShopStatusCard";

// Helper to get time-based greeting
const getGreeting = () => {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
};

// Helper to format relative time
const getRelativeTime = (date) => {
  if (!date) return "Never";
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const Dashboard = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [deviceStatus, setDeviceStatus] = useState(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    let isMounted = true;
    const loadDashboard = async () => {
      setLoading(true);
      setError("");

      const [profileResult, deviceResult] = await Promise.allSettled([
        api.get("/api/shopkeeper/me"),
        api.get("/api/dispense/device-status"),
      ]);

      if (!isMounted) return;

      if (profileResult.status === "fulfilled") {
        setData(profileResult.value.data);
      } else {
        setData(null);
        setError(
          profileResult.reason?.response?.data?.error ||
            "Could not load shop details.",
        );
      }

      setDeviceStatus(
        deviceResult.status === "fulfilled" ? deviceResult.value.data : null,
      );
      setLoading(false);
    };

    loadDashboard();
    return () => {
      isMounted = false;
    };
  }, [reloadKey]);

  // Update clock every second for relative times
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Keyboard shortcut: Press 'S' to start scan
  useEffect(() => {
    const handleKeyPress = (e) => {
      if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target;
        // Don't trigger if user is typing in an input
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && data) {
          e.preventDefault();
          navigate("/shopkeeper/scan");
        }
      }
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target;
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          setReloadKey((key) => key + 1);
        }
      }
    };
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [data, navigate]);

  const isDeviceOnline = deviceStatus?.active && deviceStatus.connectivity === "online";
  const deviceLabel =
    deviceStatus === null
      ? "Status unavailable"
      : !deviceStatus.active
        ? "No device configured"
        : deviceStatus.connectivity === "online"
          ? "Online"
          : "Offline";
  const deviceBadge = isDeviceOnline
    ? "success"
    : deviceStatus?.active
      ? "warning"
      : "neutral";

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <Skeleton.Card className="h-40" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton.Card className="h-36" />
          <Skeleton.Card className="h-36" />
          <Skeleton.Card className="h-36" />
        </div>
        <Skeleton.Card className="h-48" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl">
        <Card>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-text-primary">
                Shop details unavailable
              </h2>
              <p role="alert" className="mt-1 text-sm text-danger-text">
                {error}
              </p>
            </div>
            <Button
              variant="secondary"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              <RefreshCw size={15} />
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Hero Section with Greeting */}
      <Card className="border-2 border-brand-200 bg-gradient-to-br from-brand-50 to-white">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-brand-700">
              {getGreeting()},{" "}
              <span className="font-semibold">{data?.shopkeeper?.name || "Shopkeeper"}</span>
            </p>
            <h1 className="mt-1 text-2xl font-bold text-text-primary">
              {data?.shop?.name || "Shop Dashboard"}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-secondary">
              <span className="flex items-center gap-1.5">
                <Store size={14} />
                Code: {data?.shop?.code || "N/A"}
              </span>
              {data?.shop?.area && (
                <span className="flex items-center gap-1.5">
                  <MapPin size={14} />
                  {data.shop.area}
                </span>
              )}
              <span className="flex items-center gap-1.5">
                <Clock size={14} />
                {currentTime.toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          </div>
          <Button
            variant="primary"
            size="lg"
            className="shadow-lg shadow-brand-200 transition-all hover:shadow-xl hover:shadow-brand-300"
            onClick={() => navigate("/shopkeeper/scan")}
          >
            <QrCode size={18} />
            Start Dispensing
            <ArrowRight size={18} />
          </Button>
        </div>
        <div className="mt-4 flex items-center gap-2 text-xs text-text-secondary">
          <kbd className="rounded border border-border bg-white px-2 py-1 font-mono">
            S
          </kbd>
          <span>to start scan</span>
          <span className="mx-2">·</span>
          <kbd className="rounded border border-border bg-white px-2 py-1 font-mono">
            R
          </kbd>
          <span>to refresh</span>
        </div>
      </Card>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-3">
        {/* Transactions Today */}
        <Card className="group transition-all hover:shadow-md">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-text-secondary">
                Today's Transactions
              </p>
              <p className="mt-2 text-4xl font-bold tabular-nums text-text-primary">
                {data?.today_transactions ?? 0}
              </p>
              <p className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                <TrendingUp size={12} className="text-success-text" />
                Completed successfully
              </p>
            </div>
            <div className="rounded-lg bg-gradient-to-br from-brand-100 to-brand-50 p-3 text-brand-700 transition-transform group-hover:scale-110">
              <Package size={24} />
            </div>
          </div>
        </Card>

        {/* IoT Device Status - Enhanced with pulse */}
        <Card className={`group relative overflow-hidden transition-all hover:shadow-md ${
          isDeviceOnline ? "border-2 border-success-border bg-success-bg/5" : ""
        }`}>
          {isDeviceOnline && (
            <div className="absolute right-0 top-0 h-20 w-20 animate-ping rounded-full bg-success-500/20" />
          )}
          <div className="relative flex items-start justify-between">
            <div className="flex-1">
              <p className="text-sm font-medium text-text-secondary">
                IoT Weighing Scale
              </p>
              <p className="mt-2 text-lg font-bold text-text-primary">
                {deviceStatus?.device_name || "ESP32 Scale"}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Badge status={deviceBadge} dot className="animate-in fade-in">
                  {deviceLabel}
                </Badge>
              </div>
              {deviceStatus?.last_seen_at && (
                <p className="mt-1 text-xs text-text-secondary">
                  Last seen: {getRelativeTime(deviceStatus.last_seen_at)}
                </p>
              )}
            </div>
            <div className={`rounded-lg p-3 transition-all ${
              isDeviceOnline
                ? "bg-success-100 text-success-700"
                : "bg-surface-muted text-text-secondary"
            }`}>
              {isDeviceOnline ? (
                <Wifi size={24} className="animate-pulse" />
              ) : (
                <WifiOff size={24} />
              )}
            </div>
          </div>
        </Card>

        {/* Quick Actions */}
        <Card className="group transition-all hover:shadow-md">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-text-secondary">
                Quick Actions
              </p>
              <div className="mt-3 space-y-2">
                <button
                  onClick={() => navigate("/shopkeeper/scan")}
                  className="flex w-full items-center justify-between rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-brand-50 hover:border-brand-300"
                >
                  <span>Start Scan</span>
                  <ChevronRight size={16} />
                </button>
                <button
                  onClick={() => setReloadKey((key) => key + 1)}
                  className="flex w-full items-center justify-between rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted"
                >
                  <span>Refresh Data</span>
                  <RefreshCw size={16} />
                </button>
              </div>
            </div>
            <div className="rounded-lg bg-gradient-to-br from-amber-100 to-amber-50 p-3 text-amber-700 transition-transform group-hover:scale-110">
              <Zap size={24} />
            </div>
          </div>
        </Card>
      </div>

      <ShopStatusCard />

      {/* Shop Information Card - Enhanced */}
      <Card>
        <div className="flex items-start justify-between border-b border-border pb-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg border-2 border-brand-200 bg-brand-50 p-3 text-brand-700">
              <Store size={24} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-text-primary">
                Shop Information
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                Your assigned shop details and contact information
              </p>
            </div>
          </div>
        </div>
        
        <div className="mt-4 grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
              Shop Details
            </h3>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between py-2">
                <span className="text-text-secondary">Shop Name:</span>
                <span className="font-medium text-text-primary">
                  {data?.shop?.name || "N/A"}
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-border py-2">
                <span className="text-text-secondary">Shop Code:</span>
                <span className="font-mono font-medium text-text-primary">
                  {data?.shop?.code || "N/A"}
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-border py-2">
                <span className="text-text-secondary">Area:</span>
                <span className="font-medium text-text-primary">
                  {data?.shop?.area || "N/A"}
                </span>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
              Shopkeeper Details
            </h3>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between py-2">
                <span className="text-text-secondary">Name:</span>
                <span className="font-medium text-text-primary">
                  {data?.shopkeeper?.name || "N/A"}
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-border py-2">
                <span className="text-text-secondary">Email:</span>
                <span className="font-medium text-text-primary">
                  {data?.shopkeeper?.email || "N/A"}
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-border py-2">
                <span className="text-text-secondary">Mobile:</span>
                <span className="font-mono font-medium text-text-primary">
                  {data?.shopkeeper?.mobile || "N/A"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* System Status Footer */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm">
        <div className="flex items-center gap-2 text-text-secondary">
          <Activity size={14} />
          <span>System Status:</span>
          <Badge status="success" dot size="sm">All Systems Operational</Badge>
        </div>
        <button
          onClick={() => setReloadKey((key) => key + 1)}
          className="flex items-center gap-1.5 text-text-secondary transition-colors hover:text-brand-700"
        >
          <RefreshCw size={14} />
          <span>Last updated {getRelativeTime(new Date())}</span>
        </button>
      </div>
    </div>
  );
};

export default Dashboard;
