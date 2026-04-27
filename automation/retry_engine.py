"""Smart workflow retry engine for FormFlow Desktop Pro.

Handles retries on timeout, selector failure, navigation failure,
form validation rejection, and network errors. Supports VPN switching
between retry attempts.
"""

import asyncio
from enum import Enum
from typing import Any, Callable, Coroutine, Dict, Optional


class RetryTrigger(str, Enum):
    """Events that trigger a retry."""

    TIMEOUT = "timeout"
    SELECTOR_FAILURE = "selector_failure"
    NAVIGATION_FAILURE = "navigation_failure"
    FORM_VALIDATION_REJECTION = "form_validation_rejection"
    NETWORK_ERROR = "network_error"
    CAPTCHA_DETECTED = "captcha_detected"
    UNKNOWN_ERROR = "unknown_error"


class RetryResult:
    """Result of a retry sequence."""

    def __init__(
        self,
        success: bool,
        attempts: int,
        last_trigger: Optional[RetryTrigger] = None,
        last_error: Optional[str] = None,
        vpn_locations_used: Optional[list] = None,
    ):
        self.success = success
        self.attempts = attempts
        self.last_trigger = last_trigger
        self.last_error = last_error
        self.vpn_locations_used = vpn_locations_used or []

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "attempts": self.attempts,
            "last_trigger": self.last_trigger.value if self.last_trigger else None,
            "last_error": self.last_error,
            "vpn_locations_used": self.vpn_locations_used,
        }


class RetryEngine:
    """Manages workflow retry logic with VPN rotation support.

    Retry sequence:
        1. Detect failure trigger
        2. Switch VPN location (if VPN controller available)
        3. Re-execute workflow
        4. Repeat until max_retries reached
    """

    def __init__(
        self,
        max_retries: int = 2,
        retry_delay_seconds: float = 2.0,
        vpn_controller: Optional[object] = None,
        debug_logger: Optional[object] = None,
    ):
        self._max_retries = max_retries
        self._retry_delay = retry_delay_seconds
        self._vpn_controller = vpn_controller
        self._logger = debug_logger

    async def execute_with_retry(
        self,
        workflow_fn: Callable[..., Coroutine],
        workflow_id: Optional[str] = None,
        **kwargs: Any,
    ) -> RetryResult:
        """Execute a workflow function with automatic retry on failure.

        Args:
            workflow_fn: Async callable that runs the workflow.
            workflow_id: Optional workflow identifier for logging.
            **kwargs: Arguments to pass to the workflow function.

        Returns:
            RetryResult with success status and attempt details.
        """
        vpn_locations_used: list = []
        last_trigger: Optional[RetryTrigger] = None
        last_error: Optional[str] = None

        for attempt in range(1, self._max_retries + 2):
            is_retry = attempt > 1

            if is_retry:
                self._log_event("retry_started", workflow_id=workflow_id)
                self._log_event(
                    "retry_attempt_number",
                    workflow_id=workflow_id,
                    retry_number=attempt - 1,
                )

                if self._vpn_controller:
                    try:
                        new_location = await self._switch_vpn()
                        if new_location:
                            vpn_locations_used.append(new_location)
                    except Exception:
                        pass

                await asyncio.sleep(self._retry_delay)

            try:
                result = await workflow_fn(**kwargs)

                if is_retry:
                    self._log_event("retry_success", workflow_id=workflow_id)

                return RetryResult(
                    success=True,
                    attempts=attempt,
                    vpn_locations_used=vpn_locations_used,
                )

            except asyncio.TimeoutError as e:
                last_trigger = RetryTrigger.TIMEOUT
                last_error = str(e) or "Timeout exceeded"
            except WorkflowSelectorError as e:
                last_trigger = RetryTrigger.SELECTOR_FAILURE
                last_error = str(e)
            except WorkflowNavigationError as e:
                last_trigger = RetryTrigger.NAVIGATION_FAILURE
                last_error = str(e)
            except WorkflowValidationError as e:
                last_trigger = RetryTrigger.FORM_VALIDATION_REJECTION
                last_error = str(e)
            except WorkflowNetworkError as e:
                last_trigger = RetryTrigger.NETWORK_ERROR
                last_error = str(e)
            except WorkflowCaptchaError as e:
                last_trigger = RetryTrigger.CAPTCHA_DETECTED
                last_error = str(e)
            except Exception as e:
                last_trigger = RetryTrigger.UNKNOWN_ERROR
                last_error = str(e)

            if attempt > self._max_retries:
                break

        self._log_event(
            "retry_failed",
            workflow_id=workflow_id,
            error_message=last_error,
        )

        return RetryResult(
            success=False,
            attempts=self._max_retries + 1,
            last_trigger=last_trigger,
            last_error=last_error,
            vpn_locations_used=vpn_locations_used,
        )

    async def _switch_vpn(self) -> Optional[str]:
        """Switch VPN to the next location. Returns the new location name."""
        if not self._vpn_controller:
            return None
        try:
            return await self._vpn_controller.switch_next_location()
        except Exception:
            return None

    def _log_event(self, event: str, **kwargs: Any) -> None:
        """Log a retry event via the debug logger."""
        if self._logger:
            from debug.debug_logger import EventType

            event_map = {
                "retry_started": EventType.RETRY_STARTED,
                "retry_attempt_number": EventType.RETRY_ATTEMPT_NUMBER,
                "retry_success": EventType.RETRY_SUCCESS,
                "retry_failed": EventType.RETRY_FAILED,
            }
            event_type = event_map.get(event)
            if event_type:
                self._logger.log(event_type, **kwargs)


class WorkflowSelectorError(Exception):
    """Raised when a required selector is not found."""
    pass


class WorkflowNavigationError(Exception):
    """Raised when page navigation fails."""
    pass


class WorkflowValidationError(Exception):
    """Raised when form validation is rejected."""
    pass


class WorkflowNetworkError(Exception):
    """Raised when a network error occurs during workflow."""
    pass


class WorkflowCaptchaError(Exception):
    """Raised when CAPTCHA is detected and blocks workflow."""
    pass
