"""Execution timeline viewer for FormFlow Desktop Pro UI.

Renders a vertical timeline log stream showing the progression of
workflow events for visual debugging of failures.
"""

from typing import Any, Dict, List, Optional

from PyQt5.QtCore import Qt, QRectF, pyqtSlot
from PyQt5.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PyQt5.QtWidgets import (
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from ui.styles import STATUS_COLORS, TIMELINE_EVENT_COLORS


class TimelineEventWidget(QWidget):
    """A single event entry in the timeline."""

    def __init__(
        self,
        event: Dict[str, Any],
        parent: Optional[QWidget] = None,
    ):
        super().__init__(parent)
        self._event = event
        self.setFixedHeight(60)
        self.setMinimumWidth(400)

    def paintEvent(self, paint_event: Any) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)

        category = self._event.get("category", "app_lifecycle")
        status = self._event.get("status", "info")
        event_type = self._event.get("event", "unknown")
        timestamp = self._event.get("timestamp", "")

        dot_color = QColor(TIMELINE_EVENT_COLORS.get(category, "#e0e0e0"))
        status_color = QColor(STATUS_COLORS.get(status, "#8888aa"))

        line_x = 20
        painter.setPen(QPen(QColor("#2d2d4a"), 2))
        painter.drawLine(line_x, 0, line_x, self.height())

        painter.setBrush(dot_color)
        painter.setPen(QPen(dot_color, 2))
        painter.drawEllipse(line_x - 6, 18, 12, 12)

        text_x = 44
        painter.setPen(QColor("#8888aa"))
        painter.setFont(QFont("Consolas", 9))
        painter.drawText(text_x, 16, timestamp)

        painter.setPen(dot_color)
        painter.setFont(QFont("Segoe UI", 11, QFont.Bold))
        event_display = event_type.replace("_", " ").title()
        painter.drawText(text_x + 160, 16, event_display)

        details_parts = []
        if self._event.get("selector"):
            details_parts.append(f"selector: {self._event['selector']}")
        if self._event.get("url"):
            details_parts.append(f"url: {self._event['url']}")
        if self._event.get("vpn_location"):
            details_parts.append(f"vpn: {self._event['vpn_location']}")
        if self._event.get("ip_address"):
            details_parts.append(f"ip: {self._event['ip_address']}")
        if self._event.get("error_message"):
            details_parts.append(f"error: {self._event['error_message']}")

        if details_parts:
            painter.setPen(status_color)
            painter.setFont(QFont("Consolas", 9))
            detail_text = " | ".join(details_parts)
            if len(detail_text) > 100:
                detail_text = detail_text[:97] + "..."
            painter.drawText(text_x, 40, detail_text)

        status_x = self.width() - 80
        painter.setPen(status_color)
        painter.setFont(QFont("Segoe UI", 9, QFont.Bold))
        painter.drawText(status_x, 16, status.upper())

        painter.end()


class TimelinePanel(QWidget):
    """Vertical timeline viewer for workflow execution events."""

    def __init__(self, parent: Optional[QWidget] = None):
        super().__init__(parent)
        self._events: List[Dict[str, Any]] = []
        self._event_widgets: List[TimelineEventWidget] = []
        self._init_ui()

    def _init_ui(self) -> None:
        main_layout = QVBoxLayout(self)
        main_layout.setSpacing(8)

        # Header
        header_layout = QHBoxLayout()
        title = QLabel("Execution Timeline")
        title.setObjectName("sectionTitle")
        header_layout.addWidget(title)

        self._event_count_label = QLabel("0 events")
        self._event_count_label.setStyleSheet("color: #8888aa;")
        header_layout.addStretch()
        header_layout.addWidget(self._event_count_label)

        clear_btn = QPushButton("Clear")
        clear_btn.setFixedWidth(60)
        clear_btn.clicked.connect(self.clear)
        header_layout.addWidget(clear_btn)

        main_layout.addLayout(header_layout)

        # Filter buttons
        filter_layout = QHBoxLayout()
        self._filter_buttons = {}
        for category, color in TIMELINE_EVENT_COLORS.items():
            btn = QPushButton(category.replace("_", " ").title())
            btn.setCheckable(True)
            btn.setChecked(True)
            btn.setStyleSheet(f"""
                QPushButton {{
                    background-color: #1a1a2e;
                    color: {color};
                    border: 1px solid {color};
                    border-radius: 3px;
                    padding: 4px 8px;
                    font-size: 10px;
                }}
                QPushButton:checked {{
                    background-color: {color};
                    color: #0a0a1a;
                }}
            """)
            btn.clicked.connect(self._apply_filters)
            filter_layout.addWidget(btn)
            self._filter_buttons[category] = btn

        filter_layout.addStretch()
        main_layout.addLayout(filter_layout)

        # Scrollable Timeline
        self._scroll_area = QScrollArea()
        self._scroll_area.setWidgetResizable(True)
        self._scroll_area.setStyleSheet(
            "QScrollArea { border: 1px solid #2d2d4a; background-color: #0a0a1a; }"
        )

        self._timeline_container = QWidget()
        self._timeline_layout = QVBoxLayout(self._timeline_container)
        self._timeline_layout.setSpacing(0)
        self._timeline_layout.setContentsMargins(8, 8, 8, 8)
        self._timeline_layout.addStretch()

        self._scroll_area.setWidget(self._timeline_container)
        main_layout.addWidget(self._scroll_area)

    @pyqtSlot(dict)
    def on_event(self, event: Dict[str, Any]) -> None:
        """Add a new event to the timeline.

        Args:
            event: Debug event dictionary from DebugLogger.
        """
        self._events.append(event)

        category = event.get("category", "app_lifecycle")
        if category in self._filter_buttons:
            if not self._filter_buttons[category].isChecked():
                return

        self._add_event_widget(event)
        self._event_count_label.setText(f"{len(self._events)} events")

        scrollbar = self._scroll_area.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def _add_event_widget(self, event: Dict[str, Any]) -> None:
        """Create and add an event widget to the timeline."""
        widget = TimelineEventWidget(event)
        self._event_widgets.append(widget)

        count = self._timeline_layout.count()
        self._timeline_layout.insertWidget(count - 1, widget)

    def _apply_filters(self) -> None:
        """Rebuild the timeline based on current filter selections."""
        for widget in self._event_widgets:
            self._timeline_layout.removeWidget(widget)
            widget.deleteLater()
        self._event_widgets.clear()

        active_categories = {
            cat for cat, btn in self._filter_buttons.items() if btn.isChecked()
        }

        for event in self._events:
            if event.get("category", "app_lifecycle") in active_categories:
                self._add_event_widget(event)

    def clear(self) -> None:
        """Clear all events from the timeline."""
        for widget in self._event_widgets:
            self._timeline_layout.removeWidget(widget)
            widget.deleteLater()
        self._event_widgets.clear()
        self._events.clear()
        self._event_count_label.setText("0 events")
