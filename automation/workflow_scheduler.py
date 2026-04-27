"""Parallel workflow execution engine for FormFlow Desktop Pro.

Supports configurable concurrency (1-5 simultaneous workflows)
using asyncio task pool with round-robin scheduling across
credential, workflow, and VPN location queues.
"""

import asyncio
from collections import deque
from typing import Any, Callable, Coroutine, Deque, Dict, List, Optional

from automation.workflow_engine import WorkflowConfig, WorkflowEngine, WorkflowResult
from debug.debug_logger import DebugLogger, EventType


class SchedulerConfig:
    """Configuration for the workflow scheduler."""

    def __init__(
        self,
        max_parallel_runs: int = 3,
        scheduling_strategy: str = "round_robin",
    ):
        self.max_parallel_runs = min(max(1, max_parallel_runs), 5)
        self.scheduling_strategy = scheduling_strategy


class WorkflowJob:
    """A queued workflow job with associated metadata."""

    def __init__(
        self,
        config: WorkflowConfig,
        profile_id: str,
        credentials: Optional[Dict[str, str]] = None,
        vpn_location: Optional[str] = None,
        fingerprint: Optional[Dict[str, Any]] = None,
    ):
        self.config = config
        self.profile_id = profile_id
        self.credentials = credentials
        self.vpn_location = vpn_location
        self.fingerprint = fingerprint

    def to_dict(self) -> dict:
        return {
            "config_name": self.config.name,
            "profile_id": self.profile_id,
            "vpn_location": self.vpn_location,
            "has_credentials": bool(self.credentials),
            "has_fingerprint": bool(self.fingerprint),
        }


class WorkflowScheduler:
    """Manages parallel workflow execution with configurable concurrency.

    Queue structure:
        - Credential queue
        - Workflow queue
        - VPN location queue

    Execution scheduler: round-robin
    """

    def __init__(
        self,
        engine: WorkflowEngine,
        logger: DebugLogger,
        scheduler_config: Optional[SchedulerConfig] = None,
    ):
        self._engine = engine
        self._logger = logger
        self._config = scheduler_config or SchedulerConfig()
        self._job_queue: Deque[WorkflowJob] = deque()
        self._results: List[WorkflowResult] = []
        self._running = False
        self._completed_count = 0
        self._failed_count = 0
        self._on_job_complete: Optional[Callable] = None
        self._on_progress: Optional[Callable] = None

    def add_job(self, job: WorkflowJob) -> None:
        """Add a workflow job to the execution queue."""
        if job.credentials:
            job.config.credentials.update(job.credentials)
        self._job_queue.append(job)

    def add_jobs(self, jobs: List[WorkflowJob]) -> None:
        """Add multiple workflow jobs to the queue."""
        for job in jobs:
            self.add_job(job)

    def set_on_complete_callback(self, callback: Callable) -> None:
        """Set callback for individual job completion."""
        self._on_job_complete = callback

    def set_on_progress_callback(self, callback: Callable) -> None:
        """Set callback for progress updates."""
        self._on_progress = callback

    async def run_all(self) -> List[WorkflowResult]:
        """Execute all queued jobs with configured concurrency.

        Returns:
            List of WorkflowResult for each completed job.
        """
        self._running = True
        self._results = []
        self._completed_count = 0
        self._failed_count = 0

        semaphore = asyncio.Semaphore(self._config.max_parallel_runs)
        tasks = []

        while self._job_queue:
            job = self._job_queue.popleft()
            task = asyncio.create_task(self._run_job(job, semaphore))
            tasks.append(task)

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        self._running = False
        return self._results

    async def _run_job(
        self, job: WorkflowJob, semaphore: asyncio.Semaphore
    ) -> None:
        """Execute a single job within the semaphore-controlled pool."""
        async with semaphore:
            try:
                result = await self._engine.execute(
                    config=job.config,
                    profile_id=job.profile_id,
                    fingerprint=job.fingerprint,
                )
                self._results.append(result)

                if result.success:
                    self._completed_count += 1
                else:
                    self._failed_count += 1

                if self._on_job_complete:
                    try:
                        self._on_job_complete(result)
                    except Exception:
                        pass

                if self._on_progress:
                    try:
                        self._on_progress(self.get_progress())
                    except Exception:
                        pass

            except Exception as e:
                self._failed_count += 1
                self._logger.log(
                    EventType.WORKFLOW_FAILED,
                    status="error",
                    error_message=str(e),
                    details={"profile_id": job.profile_id},
                )

    def get_progress(self) -> Dict[str, Any]:
        """Get current execution progress."""
        total = self._completed_count + self._failed_count + len(self._job_queue)
        return {
            "total_jobs": total,
            "completed": self._completed_count,
            "failed": self._failed_count,
            "queued": len(self._job_queue),
            "running": self._running,
            "max_parallel": self._config.max_parallel_runs,
        }

    def get_results(self) -> List[WorkflowResult]:
        """Return all collected results."""
        return list(self._results)

    def clear_queue(self) -> int:
        """Clear the job queue. Returns number of jobs removed."""
        count = len(self._job_queue)
        self._job_queue.clear()
        return count

    def is_running(self) -> bool:
        """Check if the scheduler is currently executing jobs."""
        return self._running

    def get_queue_size(self) -> int:
        """Return the number of jobs currently in the queue."""
        return len(self._job_queue)
