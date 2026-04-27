"""Playwright-based registration workflow engine for FormFlow Desktop Pro.

Executes configurable registration workflows inside isolated browser profiles
with full debug telemetry logging.
"""

import asyncio
import uuid
from typing import Any, Dict, List, Optional

from automation.captcha_monitor import CaptchaMonitor
from automation.environment_simulator import EnvironmentSimulator
from automation.profile_manager import ProfileManager
from automation.retry_engine import (
    RetryEngine,
    RetryResult,
    WorkflowCaptchaError,
    WorkflowNavigationError,
    WorkflowNetworkError,
    WorkflowSelectorError,
    WorkflowValidationError,
)
from debug.debug_logger import DebugLogger, EventType
from debug.network_snapshot import NetworkSnapshot
from debug.screenshot_manager import ScreenshotManager


class WorkflowStep:
    """A single step in a registration workflow."""

    def __init__(
        self,
        action: str,
        selector: Optional[str] = None,
        value: Optional[str] = None,
        url: Optional[str] = None,
        wait_ms: int = 500,
        optional: bool = False,
    ):
        self.action = action  # navigate, fill, click, select, wait, submit, check
        self.selector = selector
        self.value = value
        self.url = url
        self.wait_ms = wait_ms
        self.optional = optional

    def to_dict(self) -> dict:
        return {
            "action": self.action,
            "selector": self.selector,
            "value": self.value,
            "url": self.url,
            "wait_ms": self.wait_ms,
            "optional": self.optional,
        }

    @staticmethod
    def from_dict(data: dict) -> "WorkflowStep":
        return WorkflowStep(
            action=data["action"],
            selector=data.get("selector"),
            value=data.get("value"),
            url=data.get("url"),
            wait_ms=data.get("wait_ms", 500),
            optional=data.get("optional", False),
        )


class WorkflowConfig:
    """Configuration for a registration workflow."""

    def __init__(
        self,
        name: str,
        target_url: str,
        steps: List[WorkflowStep],
        credentials: Optional[Dict[str, str]] = None,
        navigation_timeout_ms: int = 30000,
        selector_timeout_ms: int = 10000,
        action_delay_ms: int = 500,
    ):
        self.name = name
        self.target_url = target_url
        self.steps = steps
        self.credentials = credentials or {}
        self.navigation_timeout_ms = navigation_timeout_ms
        self.selector_timeout_ms = selector_timeout_ms
        self.action_delay_ms = action_delay_ms

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "target_url": self.target_url,
            "steps": [s.to_dict() for s in self.steps],
            "credentials": self.credentials,
            "navigation_timeout_ms": self.navigation_timeout_ms,
            "selector_timeout_ms": self.selector_timeout_ms,
            "action_delay_ms": self.action_delay_ms,
        }

    @staticmethod
    def from_dict(data: dict) -> "WorkflowConfig":
        return WorkflowConfig(
            name=data["name"],
            target_url=data["target_url"],
            steps=[WorkflowStep.from_dict(s) for s in data.get("steps", [])],
            credentials=data.get("credentials", {}),
            navigation_timeout_ms=data.get("navigation_timeout_ms", 30000),
            selector_timeout_ms=data.get("selector_timeout_ms", 10000),
            action_delay_ms=data.get("action_delay_ms", 500),
        )


class WorkflowResult:
    """Result of a single workflow execution."""

    def __init__(
        self,
        workflow_id: str,
        profile_id: str,
        success: bool,
        steps_completed: int = 0,
        total_steps: int = 0,
        error_message: Optional[str] = None,
        retry_result: Optional[RetryResult] = None,
        screenshots: Optional[List[str]] = None,
        duration_seconds: float = 0.0,
    ):
        self.workflow_id = workflow_id
        self.profile_id = profile_id
        self.success = success
        self.steps_completed = steps_completed
        self.total_steps = total_steps
        self.error_message = error_message
        self.retry_result = retry_result
        self.screenshots = screenshots or []
        self.duration_seconds = duration_seconds

    def to_dict(self) -> dict:
        return {
            "workflow_id": self.workflow_id,
            "profile_id": self.profile_id,
            "success": self.success,
            "steps_completed": self.steps_completed,
            "total_steps": self.total_steps,
            "error_message": self.error_message,
            "retry_result": self.retry_result.to_dict() if self.retry_result else None,
            "screenshots": self.screenshots,
            "duration_seconds": self.duration_seconds,
        }


class WorkflowEngine:
    """Executes registration workflows using Playwright with full telemetry.

    Each workflow runs inside an isolated browser profile with optional
    environment simulation (timezone, locale, viewport, user agent).
    """

    def __init__(
        self,
        logger: DebugLogger,
        profile_manager: ProfileManager,
        env_simulator: EnvironmentSimulator,
        screenshot_manager: ScreenshotManager,
        network_snapshot: NetworkSnapshot,
        captcha_monitor: Optional[CaptchaMonitor] = None,
        retry_engine: Optional[RetryEngine] = None,
    ):
        self._logger = logger
        self._profile_manager = profile_manager
        self._env_simulator = env_simulator
        self._screenshot_mgr = screenshot_manager
        self._network = network_snapshot
        self._captcha = captcha_monitor or CaptchaMonitor()
        self._retry = retry_engine

    async def execute(
        self,
        config: WorkflowConfig,
        profile_id: str,
        fingerprint: Optional[Dict[str, Any]] = None,
    ) -> WorkflowResult:
        """Execute a registration workflow with full telemetry.

        Args:
            config: Workflow configuration with steps and credentials.
            profile_id: Browser profile to use for isolation.
            fingerprint: Optional environment fingerprint (auto-generated if None).

        Returns:
            WorkflowResult with execution details.
        """
        workflow_id = str(uuid.uuid4())[:8]
        self._logger.log(
            EventType.WORKFLOW_STARTED,
            workflow_id=workflow_id,
            profile_id=profile_id,
            url=config.target_url,
        )

        if not fingerprint:
            fingerprint = self._env_simulator.generate_fingerprint()

        profile_path = self._profile_manager.get_or_create_profile(
            profile_id, fingerprint
        )
        self._env_simulator.save_fingerprint_to_profile(fingerprint, profile_path)

        if self._retry:
            retry_result = await self._retry.execute_with_retry(
                self._run_workflow,
                workflow_id=workflow_id,
                config=config,
                profile_path=profile_path,
                fingerprint=fingerprint,
                workflow_id_param=workflow_id,
                profile_id=profile_id,
            )
            success = retry_result.success
            return WorkflowResult(
                workflow_id=workflow_id,
                profile_id=profile_id,
                success=success,
                steps_completed=len(config.steps) if success else 0,
                total_steps=len(config.steps),
                retry_result=retry_result,
                error_message=retry_result.last_error if not success else None,
            )
        else:
            try:
                await self._run_workflow(
                    config=config,
                    profile_path=profile_path,
                    fingerprint=fingerprint,
                    workflow_id_param=workflow_id,
                    profile_id=profile_id,
                )
                self._logger.log(
                    EventType.WORKFLOW_FINISHED,
                    workflow_id=workflow_id,
                    status="success",
                )
                return WorkflowResult(
                    workflow_id=workflow_id,
                    profile_id=profile_id,
                    success=True,
                    steps_completed=len(config.steps),
                    total_steps=len(config.steps),
                )
            except Exception as e:
                self._logger.log(
                    EventType.WORKFLOW_FAILED,
                    workflow_id=workflow_id,
                    status="failed",
                    error_message=str(e),
                )
                return WorkflowResult(
                    workflow_id=workflow_id,
                    profile_id=profile_id,
                    success=False,
                    total_steps=len(config.steps),
                    error_message=str(e),
                )

    async def _run_workflow(
        self,
        config: WorkflowConfig,
        profile_path: str,
        fingerprint: Dict[str, Any],
        workflow_id_param: str,
        profile_id: str,
        **kwargs: Any,
    ) -> None:
        """Internal workflow runner inside a Playwright context."""
        from playwright.async_api import async_playwright

        context_options = self._env_simulator.apply_to_playwright_context(fingerprint)

        self._logger.log(
            EventType.BROWSER_LAUNCH,
            workflow_id=workflow_id_param,
            profile_id=profile_id,
            details={"fingerprint": fingerprint},
        )

        async with async_playwright() as p:
            context = await p.chromium.launch_persistent_context(
                profile_path,
                headless=False,
                **context_options,
            )

            page = await context.new_page()
            self._logger.log(
                EventType.PAGE_OPEN,
                workflow_id=workflow_id_param,
                url=config.target_url,
            )

            await self._network.capture(
                timezone=fingerprint.get("timezone"),
                locale=fingerprint.get("locale"),
                user_agent=fingerprint.get("user_agent"),
                viewport=fingerprint.get("viewport"),
            )

            try:
                for step in config.steps:
                    await self._execute_step(
                        page, step, config, workflow_id_param, profile_id
                    )

                    captcha_result = await self._captcha.detect(page)
                    if captcha_result.detected:
                        self._logger.log(
                            EventType.CAPTCHA_DETECTED,
                            workflow_id=workflow_id_param,
                            status="warning",
                            details=captcha_result.to_dict(),
                        )
                        screenshot = await self._screenshot_mgr.capture_captcha(
                            page, workflow_id_param
                        )
                        if screenshot:
                            self._logger.log(
                                EventType.CAPTCHA_SCREENSHOT_SAVED,
                                workflow_id=workflow_id_param,
                                screenshot_path=screenshot,
                            )
                        self._logger.log(
                            EventType.WORKFLOW_PAUSED,
                            workflow_id=workflow_id_param,
                            status="warning",
                            details={"reason": "captcha_detected"},
                        )
                        raise WorkflowCaptchaError(
                            f"CAPTCHA detected: {captcha_result.captcha_type}"
                        )

            except (WorkflowCaptchaError, WorkflowSelectorError,
                    WorkflowNavigationError, WorkflowNetworkError,
                    WorkflowValidationError):
                raise
            except Exception as e:
                screenshot = await self._screenshot_mgr.capture_failure(
                    page, workflow_id_param
                )
                if screenshot:
                    self._logger.log(
                        EventType.WORKFLOW_FAILED,
                        workflow_id=workflow_id_param,
                        screenshot_path=screenshot,
                        error_message=str(e),
                    )
                raise
            finally:
                self._logger.log(
                    EventType.PAGE_CLOSED,
                    workflow_id=workflow_id_param,
                )
                await context.close()

    async def _execute_step(
        self,
        page: Any,
        step: WorkflowStep,
        config: WorkflowConfig,
        workflow_id: str,
        profile_id: str,
    ) -> None:
        """Execute a single workflow step with telemetry."""
        if step.action == "navigate":
            url = step.url or config.target_url
            try:
                await page.goto(
                    url, timeout=config.navigation_timeout_ms, wait_until="domcontentloaded"
                )
                self._logger.log(
                    EventType.NAVIGATION_SUCCESS,
                    workflow_id=workflow_id,
                    url=url,
                    status="success",
                )
            except Exception as e:
                self._logger.log(
                    EventType.NAVIGATION_TIMEOUT,
                    workflow_id=workflow_id,
                    url=url,
                    status="failed",
                    error_message=str(e),
                )
                if not step.optional:
                    screenshot = await self._screenshot_mgr.capture_timeout(
                        page, workflow_id
                    )
                    raise WorkflowNavigationError(f"Navigation failed: {url}: {e}")

        elif step.action == "fill":
            await self._fill_field(page, step, config, workflow_id)

        elif step.action == "click":
            await self._click_element(page, step, config, workflow_id)

        elif step.action == "select":
            await self._select_option(page, step, config, workflow_id)

        elif step.action == "wait":
            await asyncio.sleep(step.wait_ms / 1000)

        elif step.action == "submit":
            await self._click_element(page, step, config, workflow_id)

        elif step.action == "check":
            await self._check_element(page, step, config, workflow_id)

        await asyncio.sleep(config.action_delay_ms / 1000)

    async def _fill_field(
        self, page: Any, step: WorkflowStep, config: WorkflowConfig, workflow_id: str
    ) -> None:
        """Fill a form field with value substitution from credentials."""
        selector = step.selector
        value = step.value or ""

        if value.startswith("{{") and value.endswith("}}"):
            cred_key = value[2:-2].strip()
            value = config.credentials.get(cred_key, value)

        self._logger.log(
            EventType.SELECTOR_FILL_ATTEMPT,
            workflow_id=workflow_id,
            selector=selector,
            status="info",
        )

        try:
            element = await page.wait_for_selector(
                selector, timeout=config.selector_timeout_ms
            )
            if element:
                self._logger.log(
                    EventType.SELECTOR_DETECTED,
                    workflow_id=workflow_id,
                    selector=selector,
                    status="success",
                )
                await element.fill(value)
                self._logger.log(
                    EventType.SELECTOR_FILL_SUCCESS,
                    workflow_id=workflow_id,
                    selector=selector,
                    status="success",
                )
            else:
                raise WorkflowSelectorError(f"Selector not found: {selector}")
        except WorkflowSelectorError:
            raise
        except Exception as e:
            self._logger.log(
                EventType.SELECTOR_FILL_FAILED,
                workflow_id=workflow_id,
                selector=selector,
                status="failed",
                error_message=str(e),
            )
            if not step.optional:
                self._logger.log(
                    EventType.SELECTOR_MISSING,
                    workflow_id=workflow_id,
                    selector=selector,
                    status="failed",
                )
                await self._screenshot_mgr.capture_selector_missing(
                    page, selector, workflow_id
                )
                raise WorkflowSelectorError(f"Fill failed for {selector}: {e}")

    async def _click_element(
        self, page: Any, step: WorkflowStep, config: WorkflowConfig, workflow_id: str
    ) -> None:
        """Click an element on the page."""
        selector = step.selector
        self._logger.log(
            EventType.SELECTOR_FILL_ATTEMPT,
            workflow_id=workflow_id,
            selector=selector,
            status="info",
        )

        try:
            element = await page.wait_for_selector(
                selector, timeout=config.selector_timeout_ms
            )
            if element:
                self._logger.log(
                    EventType.SELECTOR_DETECTED,
                    workflow_id=workflow_id,
                    selector=selector,
                    status="success",
                )
                await element.click()
                self._logger.log(
                    EventType.SELECTOR_FILL_SUCCESS,
                    workflow_id=workflow_id,
                    selector=selector,
                    status="success",
                )
            else:
                raise WorkflowSelectorError(f"Selector not found: {selector}")
        except WorkflowSelectorError:
            raise
        except Exception as e:
            if not step.optional:
                self._logger.log(
                    EventType.SELECTOR_MISSING,
                    workflow_id=workflow_id,
                    selector=selector,
                    status="failed",
                    error_message=str(e),
                )
                raise WorkflowSelectorError(f"Click failed for {selector}: {e}")

    async def _select_option(
        self, page: Any, step: WorkflowStep, config: WorkflowConfig, workflow_id: str
    ) -> None:
        """Select an option from a dropdown."""
        selector = step.selector
        value = step.value or ""

        try:
            element = await page.wait_for_selector(
                selector, timeout=config.selector_timeout_ms
            )
            if element:
                self._logger.log(
                    EventType.SELECTOR_DETECTED,
                    workflow_id=workflow_id,
                    selector=selector,
                    status="success",
                )
                await page.select_option(selector, value)
                self._logger.log(
                    EventType.SELECTOR_FILL_SUCCESS,
                    workflow_id=workflow_id,
                    selector=selector,
                    status="success",
                )
        except Exception as e:
            if not step.optional:
                raise WorkflowSelectorError(f"Select failed for {selector}: {e}")

    async def _check_element(
        self, page: Any, step: WorkflowStep, config: WorkflowConfig, workflow_id: str
    ) -> None:
        """Check (checkbox/radio) an element."""
        selector = step.selector

        try:
            element = await page.wait_for_selector(
                selector, timeout=config.selector_timeout_ms
            )
            if element:
                is_checked = await element.is_checked()
                if not is_checked:
                    await element.check()
                self._logger.log(
                    EventType.SELECTOR_FILL_SUCCESS,
                    workflow_id=workflow_id,
                    selector=selector,
                    status="success",
                )
        except Exception as e:
            if not step.optional:
                raise WorkflowSelectorError(f"Check failed for {selector}: {e}")
