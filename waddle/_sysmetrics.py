"""SystemMonitor — background daemon thread for CPU/mem/GPU metrics."""

from __future__ import annotations

import threading
import time
from typing import TYPE_CHECKING, Dict

if TYPE_CHECKING:
    from ._run import Run


class SystemMonitor:
    def __init__(self, run: Run, interval: float = 5.0):
        self._run = run
        self._interval = interval
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._step = 0
        self._prev_io: tuple | None = None  # (ts, disk_io_counters, net_io_counters) for rate deltas

        # probe capabilities
        self._has_psutil = False
        self._has_pynvml = False
        self._gpu_count = 0

        try:
            import psutil  # noqa: F401
            self._has_psutil = True
        except ImportError:
            pass

        try:
            import pynvml
            pynvml.nvmlInit()
            self._gpu_count = pynvml.nvmlDeviceGetCount()
            self._has_pynvml = self._gpu_count > 0
        except Exception:
            pass

    def start(self) -> None:
        if not self._has_psutil and not self._has_pynvml:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                metrics = self._sample()
                if metrics:
                    # log_metric (not a raw INSERT) so rank/node_id/attempt are
                    # attributed to this worker — a resumed run logs its own attempt.
                    ts = time.time()
                    step = self._step
                    self._step += 1
                    for key, value in metrics.items():
                        self._run.log_metric(key, step, float(value), ts)
            except Exception:
                pass
            self._stop_event.wait(self._interval)

    def _sample(self) -> Dict[str, float]:
        # Key suffixes carry the unit (_percent, _temp_c, _gb, _w, _mhz, _mbps):
        # the dashboard groups system charts by suffix, so a new key with a known
        # suffix lands on the right chart with no page change.
        metrics: Dict[str, float] = {}

        if self._has_psutil:
            try:
                import psutil
                metrics["system/cpu_percent"] = psutil.cpu_percent(interval=None)
                mem = psutil.virtual_memory()
                metrics["system/memory_percent"] = mem.percent
                metrics["system/memory_used_gb"] = mem.used / (1024 ** 3)
                metrics["system/proc_memory_gb"] = psutil.Process().memory_info().rss / (1024 ** 3)
                now = time.time()
                disk = psutil.disk_io_counters()
                net = psutil.net_io_counters()
                if self._prev_io is not None:
                    p_ts, p_disk, p_net = self._prev_io
                    dt = max(1e-9, now - p_ts)
                    mb = 1024 ** 2
                    metrics["system/disk_read_mbps"] = (disk.read_bytes - p_disk.read_bytes) / mb / dt
                    metrics["system/disk_write_mbps"] = (disk.write_bytes - p_disk.write_bytes) / mb / dt
                    metrics["system/net_sent_mbps"] = (net.bytes_sent - p_net.bytes_sent) / mb / dt
                    metrics["system/net_recv_mbps"] = (net.bytes_recv - p_net.bytes_recv) / mb / dt
                self._prev_io = (now, disk, net)
            except Exception:
                pass

        if self._has_pynvml:
            try:
                import pynvml
                for i in range(self._gpu_count):
                    handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                    util = pynvml.nvmlDeviceGetUtilizationRates(handle)
                    mem_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
                    prefix = f"system/gpu{i}"
                    metrics[f"{prefix}_util_percent"] = float(util.gpu)
                    metrics[f"{prefix}_memory_used_gb"] = mem_info.used / (1024 ** 3)
                    metrics[f"{prefix}_memory_percent"] = 100.0 * mem_info.used / max(1, mem_info.total)
                    try:
                        metrics[f"{prefix}_temp_c"] = float(
                            pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU))
                    except Exception:
                        pass
                    try:
                        metrics[f"{prefix}_power_w"] = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
                    except Exception:
                        pass
                    try:
                        metrics[f"{prefix}_sm_clock_mhz"] = float(
                            pynvml.nvmlDeviceGetClockInfo(handle, pynvml.NVML_CLOCK_SM))
                    except Exception:
                        pass
            except Exception:
                pass

        return metrics
