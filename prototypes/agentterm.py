"""
AgentTerm GUI Demo - A terminal/SSH client with AI assistant
Based on the design from image (5).png
"""

import tkinter as tk
from tkinter import ttk
import datetime


class AgentTermApp:
    # ── Color Palette (Dark Theme) ──────────────────────────────────────
    BG_DARK      = "#1a1b26"
    BG_SIDEBAR   = "#16161e"
    BG_PANEL     = "#1f2335"
    BG_INPUT     = "#24283b"
    BG_TERMINAL  = "#0d0d14"
    BG_FILE      = "#16161e"
    BG_AI        = "#1a1b26"
    FG_PRIMARY   = "#c0caf5"
    FG_SECONDARY = "#565f89"
    FG_DIM       = "#3b4261"
    FG_GREEN     = "#9ece6a"
    FG_BLUE      = "#7aa2f7"
    FG_RED       = "#f7768e"
    FG_YELLOW    = "#e0af68"
    FG_CYAN      = "#7dcfff"
    FG_PURPLE    = "#bb9af7"
    FG_ORANGE    = "#ff9e64"
    ACCENT_GREEN = "#73daca"
    BORDER       = "#292e42"
    BTN_CONNECT  = "#9ece6a"
    BTN_PROFILE  = "#24283b"

    def __init__(self, root):
        self.root = root
        self.root.title("AgentTerm")
        self.root.geometry("1400x850")
        self.root.configure(bg=self.BG_DARK)
        self.root.minsize(1100, 700)

        self._build_ui()

    # ── Helpers ──────────────────────────────────────────────────────────
    def _label(self, parent, text, **kw):
        defaults = dict(bg=kw.pop("bg", parent.cget("bg")),
                        fg=kw.pop("fg", self.FG_PRIMARY),
                        font=kw.pop("font", ("Consolas", 10)))
        defaults.update(kw)
        return tk.Label(parent, text=text, **defaults)

    def _frame(self, parent, bg=None, **kw):
        return tk.Frame(parent, bg=bg or self.BG_DARK, **kw)

    def _button(self, parent, text, command=None, **kw):
        defaults = dict(bg=kw.pop("bg", self.BTN_CONNECT),
                        fg=kw.pop("fg", self.BG_DARK),
                        font=kw.pop("font", ("Consolas", 10, "bold")),
                        relief=tk.FLAT, cursor="hand2",
                        activebackground=kw.pop("activebackground", self.FG_GREEN),
                        activeforeground=kw.pop("activeforeground", self.BG_DARK),
                        padx=kw.pop("padx", 12), pady=kw.pop("pady", 4))
        defaults.update(kw)
        btn = tk.Button(parent, text=text, command=command, **defaults)
        return btn

    def _entry(self, parent, placeholder="", **kw):
        defaults = dict(bg=kw.pop("bg", self.BG_INPUT),
                        fg=kw.pop("fg", self.FG_PRIMARY),
                        insertbackground=self.FG_PRIMARY,
                        font=kw.pop("font", ("Consolas", 10)),
                        relief=tk.FLAT, bd=0,
                        highlightthickness=1,
                        highlightcolor=self.FG_BLUE,
                        highlightbackground=self.BORDER)
        defaults.update(kw)
        e = tk.Entry(parent, **defaults)
        if placeholder:
            e.insert(0, placeholder)
            e.config(fg=self.FG_SECONDARY)
            e.bind("<FocusIn>", lambda ev: self._clear_placeholder(ev, placeholder))
            e.bind("<FocusOut>", lambda ev: self._set_placeholder(ev, placeholder))
        return e

    def _clear_placeholder(self, event, placeholder):
        e = event.widget
        if e.get() == placeholder:
            e.delete(0, tk.END)
            e.config(fg=self.FG_PRIMARY)

    def _set_placeholder(self, event, placeholder):
        e = event.widget
        if not e.get():
            e.insert(0, placeholder)
            e.config(fg=self.FG_SECONDARY)

    def _separator(self, parent, horizontal=True):
        if horizontal:
            f = tk.Frame(parent, bg=self.BORDER, height=1)
        else:
            f = tk.Frame(parent, bg=self.BORDER, width=1)
        return f

    # ── Main Layout ─────────────────────────────────────────────────────
    def _build_ui(self):
        main = self._frame(self.root, self.BG_DARK)
        main.pack(fill=tk.BOTH, expand=True)

        # Three-column layout
        main.columnconfigure(0, weight=0, minsize=280)   # Left sidebar
        main.columnconfigure(1, weight=1)                  # Center
        main.columnconfigure(2, weight=0, minsize=360)    # Right AI panel
        main.rowconfigure(0, weight=1)

        self._build_left_sidebar(main)
        self._build_center_panel(main)
        self._build_right_panel(main)

    # ── LEFT SIDEBAR ────────────────────────────────────────────────────
    def _build_left_sidebar(self, parent):
        sidebar = self._frame(parent, self.BG_SIDEBAR)
        sidebar.grid(row=0, column=0, sticky="nsew", padx=(0, 1))
        sidebar.grid_propagate(False)

        # Top buttons
        top = self._frame(sidebar, self.BG_SIDEBAR)
        top.pack(fill=tk.X, padx=10, pady=(12, 6))

        self._button(top, " Connect ", bg=self.BTN_CONNECT).pack(side=tk.LEFT, padx=(0, 6))
        self._button(top, " Profile ", bg=self.BTN_PROFILE,
                     fg=self.FG_PRIMARY).pack(side=tk.LEFT)

        # Connection type tabs
        self._separator(sidebar).pack(fill=tk.X, padx=10, pady=(10, 0))

        tabs = self._frame(sidebar, self.BG_SIDEBAR)
        tabs.pack(fill=tk.X, padx=10, pady=(4, 0))

        self._conn_tabs = {}
        for i, name in enumerate(["SSH", "Telnet", "Serial"]):
            fg = self.FG_GREEN if i == 0 else self.FG_SECONDARY
            tab = self._label(tabs, name, font=("Consolas", 10, "bold" if i == 0 else "normal"),
                              fg=fg, cursor="hand2")
            tab.pack(side=tk.LEFT, padx=(0, 16), pady=6)
            self._conn_tabs[name] = tab
            tab.bind("<Button-1>", lambda ev, n=name: self._switch_tab(n))

        # SSH indicator line
        self._tab_indicator = tk.Frame(sidebar, bg=self.FG_GREEN, height=2)
        self._tab_indicator.place(x=10, rely=0, relx=0, y=62, width=30)

        self._separator(sidebar).pack(fill=tk.X, padx=10)

        # CONNECT section
        conn_section = self._frame(sidebar, self.BG_SIDEBAR)
        conn_section.pack(fill=tk.X, padx=10, pady=(8, 0))

        self._label(conn_section, "CONNECT", font=("Consolas", 9, "bold"),
                    fg=self.FG_SECONDARY).pack(anchor="w", pady=(0, 6))

        fields = [("Name", "920G-Server"), ("Host", "192.168.1.***"),
                  ("Port", "22"), ("User", "root"), ("Password", "••••••••")]
        for label_text, default in fields:
            row = self._frame(conn_section, self.BG_SIDEBAR)
            row.pack(fill=tk.X, pady=2)
            self._label(row, label_text, font=("Consolas", 9),
                        fg=self.FG_SECONDARY).pack(anchor="w")
            e = self._entry(row, default, font=("Consolas", 9))
            e.pack(fill=tk.X, ipady=3, pady=(1, 0))

        # Options toggle
        opt = self._frame(sidebar, self.BG_SIDEBAR)
        opt.pack(fill=tk.X, padx=10, pady=(6, 0))
        self._label(opt, "▸ Options", font=("Consolas", 9),
                    fg=self.FG_SECONDARY, cursor="hand2").pack(anchor="w")

        self._separator(sidebar).pack(fill=tk.X, padx=10, pady=(12, 0))

        # RECENT CONNECTIONS
        recent = self._frame(sidebar, self.BG_SIDEBAR)
        recent.pack(fill=tk.X, padx=10, pady=(8, 0))

        self._label(recent, "RECENT CONNECTIONS", font=("Consolas", 9, "bold"),
                    fg=self.FG_SECONDARY).pack(anchor="w", pady=(0, 6))

        rc_item = self._frame(recent, self.BG_PANEL)
        rc_item.pack(fill=tk.X, pady=2, ipady=4)
        self._label(rc_item, "  920G-Prod", bg=self.BG_PANEL,
                    fg=self.FG_PRIMARY, font=("Consolas", 9)).pack(side=tk.LEFT)
        btn_frame = self._frame(rc_item, self.BG_PANEL)
        btn_frame.pack(side=tk.RIGHT, padx=6)
        self._label(btn_frame, "🔗", bg=self.BG_PANEL, fg=self.FG_GREEN,
                    font=("Consolas", 10), cursor="hand2").pack(side=tk.LEFT, padx=2)
        self._label(btn_frame, "✕", bg=self.BG_PANEL, fg=self.FG_RED,
                    font=("Consolas", 10), cursor="hand2").pack(side=tk.LEFT, padx=2)

        self._separator(sidebar).pack(fill=tk.X, padx=10, pady=(12, 0))

        # SESSIONS
        sessions = self._frame(sidebar, self.BG_SIDEBAR)
        sessions.pack(fill=tk.X, padx=10, pady=(8, 0))

        self._label(sessions, "SESSIONS", font=("Consolas", 9, "bold"),
                    fg=self.FG_SECONDARY).pack(anchor="w", pady=(0, 6))

        sess_item = self._frame(sessions, self.BG_PANEL)
        sess_item.pack(fill=tk.X, ipady=4)
        self._label(sess_item, "  🟢 920G", bg=self.BG_PANEL,
                    fg=self.FG_GREEN, font=("Consolas", 9)).pack(side=tk.LEFT)

        self._separator(sidebar).pack(fill=tk.X, padx=10, pady=(12, 0))

        # SAVED PROFILES
        profiles = self._frame(sidebar, self.BG_SIDEBAR)
        profiles.pack(fill=tk.X, padx=10, pady=(8, 0))

        self._label(profiles, "SAVED PROFILES", font=("Consolas", 9, "bold"),
                    fg=self.FG_SECONDARY).pack(anchor="w", pady=(0, 6))
        self._label(profiles, "No saved profiles", font=("Consolas", 9),
                    fg=self.FG_DIM).pack(anchor="w")

    def _switch_tab(self, name):
        for t, label in self._conn_tabs.items():
            if t == name:
                label.config(fg=self.FG_GREEN, font=("Consolas", 10, "bold"))
            else:
                label.config(fg=self.FG_SECONDARY, font=("Consolas", 10, "normal"))

    # ── CENTER PANEL ────────────────────────────────────────────────────
    def _build_center_panel(self, parent):
        center = self._frame(parent, self.BG_DARK)
        center.grid(row=0, column=1, sticky="nsew", padx=1)
        center.grid_propagate(False)
        center.rowconfigure(1, weight=3)
        center.rowconfigure(3, weight=1)
        center.columnconfigure(0, weight=1)

        # Terminal toolbar
        toolbar = self._frame(center, self.BG_PANEL)
        toolbar.grid(row=0, column=0, sticky="ew")
        toolbar.grid_columnconfigure(1, weight=1)

        self._label(toolbar, "  920G-Server  ", bg=self.BG_PANEL,
                    fg=self.FG_GREEN, font=("Consolas", 10, "bold")).grid(row=0, column=0, sticky="w")

        icons_frame = self._frame(toolbar, self.BG_PANEL)
        icons_frame.grid(row=0, column=1, sticky="e", padx=8)
        for icon in ["◐", "ℹ", "🛡", "⬇", "⚙"]:
            self._label(icons_frame, icon, bg=self.BG_PANEL,
                        fg=self.FG_SECONDARY, font=("Consolas", 12),
                        cursor="hand2").pack(side=tk.RIGHT, padx=4)

        # Terminal area
        term_frame = self._frame(center, self.BG_TERMINAL)
        term_frame.grid(row=1, column=0, sticky="nsew", pady=1)
        term_frame.grid_propagate(False)

        term = tk.Text(term_frame, bg=self.BG_TERMINAL, fg=self.FG_PRIMARY,
                       font=("Consolas", 10), relief=tk.FLAT, bd=0,
                       insertbackground=self.FG_GREEN,
                       selectbackground=self.FG_BLUE,
                       wrap=tk.WORD, padx=12, pady=10)
        term.pack(fill=tk.BOTH, expand=True)

        # Populate terminal
        terminal_text = (
            "Authorized users only. All activities may be monitored and reported.\n"
            "Activate the web console with: systemctl enable --now cockpit.socket\n"
            "\n"
            "Last login: Mon Jun  8 18:07:08 2026 from 10.0.1.42\n"
            "\n"
            f"Welcome to 6.6.0-98.0.0.103.oe2403sp2.aarch64\n"
            "\n"
            "System information as of time: Mon Jun  8 10:08:32 PM CST 2026\n"
            "\n"
            "  System load:  0.00\n"
            "  Memory used:  1.7%\n"
            "  Swap used:    0.0%\n"
            "  Usage On:     55%\n"
            "  IP address:   10.0.1.100\n"
            "  Users online: 2\n"
            "\n"
            "_AGENTTERM_SHELL_INTEGRATION_READY_mq5asz3u__\n"
        )
        term.insert(tk.END, terminal_text)
        term.insert(tk.END, "[root@localhost ~]# ", "prompt")
        term.tag_config("prompt", foreground=self.FG_GREEN)
        term.config(state=tk.DISABLED)
        term.config(state=tk.NORMAL)
        term.see(tk.END)

        # File browser toolbar
        fb_toolbar = self._frame(center, self.BG_PANEL)
        fb_toolbar.grid(row=2, column=0, sticky="ew", pady=(1, 0))
        fb_toolbar.grid_columnconfigure(1, weight=1)

        self._label(fb_toolbar, "  📁 File Browser", bg=self.BG_PANEL,
                    fg=self.FG_CYAN, font=("Consolas", 10, "bold")).grid(row=0, column=0, sticky="w")

        fb_icons = self._frame(fb_toolbar, self.BG_PANEL)
        fb_icons.grid(row=0, column=1, sticky="e", padx=8)
        for icon, fg in [("🔄", self.FG_GREEN), ("⬆", self.FG_SECONDARY),
                         ("⬇", self.FG_SECONDARY), ("🗑", self.FG_SECONDARY)]:
            self._label(fb_icons, icon, bg=self.BG_PANEL,
                        fg=fg, font=("Consolas", 12),
                        cursor="hand2").pack(side=tk.RIGHT, padx=4)

        # File browser
        fb_frame = self._frame(center, self.BG_FILE)
        fb_frame.grid(row=3, column=0, sticky="nsew")
        fb_frame.grid_propagate(False)

        # Path bar
        path_bar = self._frame(fb_frame, self.BG_INPUT)
        path_bar.pack(fill=tk.X, padx=8, pady=(8, 4))
        self._label(path_bar, "  .  ", bg=self.BG_INPUT,
                    fg=self.FG_SECONDARY, font=("Consolas", 9)).pack(side=tk.LEFT)

        # File list header
        header = self._frame(fb_frame, self.BG_FILE)
        header.pack(fill=tk.X, padx=8)
        self._label(header, "0 selected", bg=self.BG_FILE,
                    fg=self.FG_SECONDARY, font=("Consolas", 9)).pack(side=tk.LEFT)

        # File list
        file_list = tk.Text(fb_frame, bg=self.BG_FILE, fg=self.FG_PRIMARY,
                            font=("Consolas", 10), relief=tk.FLAT, bd=0,
                            wrap=tk.NONE, padx=12, pady=6, height=5)
        file_list.pack(fill=tk.BOTH, expand=True, padx=8)

        file_list.insert(tk.END, "📁 ..  (Parent)\n", "dir")
        file_list.tag_config("dir", foreground=self.FG_CYAN)

        no_files_frame = self._frame(fb_frame, self.BG_FILE)
        no_files_frame.place(relx=0.5, rely=0.65, anchor="center")
        self._label(no_files_frame, "No files listed", bg=self.BG_FILE,
                    fg=self.FG_DIM, font=("Consolas", 10)).pack()

    # ── RIGHT PANEL (AI Assistant) ──────────────────────────────────────
    def _build_right_panel(self, parent):
        right = self._frame(parent, self.BG_AI)
        right.grid(row=0, column=2, sticky="nsew", padx=(1, 0))
        right.grid_propagate(False)

        # Header
        header = self._frame(right, self.BG_PANEL)
        header.pack(fill=tk.X)
        header.grid_columnconfigure(1, weight=1)

        self._label(header, "  opencode", bg=self.BG_PANEL,
                    fg=self.FG_PURPLE, font=("Consolas", 12, "bold")).grid(row=0, column=0, sticky="w")

        status_dot = self._label(header, " ● running ", bg=self.BG_PANEL,
                                 fg=self.FG_GREEN, font=("Consolas", 9))
        status_dot.grid(row=0, column=1, sticky="w", padx=(4, 0))

        hdr_icons = self._frame(header, self.BG_PANEL)
        hdr_icons.grid(row=0, column=2, sticky="e", padx=8)
        for icon in ["📄", "📁", "▶", "🖼", "⚙"]:
            self._label(hdr_icons, icon, bg=self.BG_PANEL,
                        fg=self.FG_SECONDARY, font=("Consolas", 11),
                        cursor="hand2").pack(side=tk.RIGHT, padx=3)

        # Bridge status
        bridge = self._frame(right, self.BG_DARK)
        bridge.pack(fill=tk.X, padx=0, pady=0)
        self._label(bridge, "  agentterm-bridge/v2", bg=self.BG_DARK,
                    fg=self.FG_SECONDARY, font=("Consolas", 9)).pack(side=tk.LEFT, padx=4, pady=4)
        self._label(bridge, "tools ready", bg=self.BG_DARK,
                    fg=self.FG_GREEN, font=("Consolas", 9)).pack(side=tk.RIGHT, padx=8, pady=4)

        # Main AI area
        ai_area = self._frame(right, self.BG_AI)
        ai_area.pack(fill=tk.BOTH, expand=True)

        # ASCII Art
        ascii_art = (
            "\n"
            "   ___  ____  ___  ____  ____\n"
            "  / _ \\/ ___\\/ _ \\/   _\\/  __\\\n"
            "  / //_/  _  / //_//  /  |  \\/|\n"
            " / _  /  // // _  /  /__ |    /\n"
            " \\//\\_/\\____/\\//\\_/\\____/\\_/\\_\\\n"
            "\n"
            "         opencode\n"
        )
        self._label(ai_area, ascii_art, fg=self.FG_PURPLE,
                    font=("Consolas", 9), justify=tk.CENTER).pack(pady=(30, 10))

        # Description
        self._label(ai_area, "AI-powered coding assistant\nintegrated with your terminal",
                    fg=self.FG_SECONDARY, font=("Consolas", 9),
                    justify=tk.CENTER).pack(pady=(0, 20))

        # Input area
        input_container = self._frame(ai_area, self.BG_INPUT)
        input_container.pack(fill=tk.X, padx=16, pady=(0, 4))

        input_inner = self._frame(input_container, self.BG_INPUT)
        input_inner.pack(fill=tk.X, padx=8, pady=8)

        ai_input = tk.Text(input_inner, bg=self.BG_INPUT, fg=self.FG_PRIMARY,
                           font=("Consolas", 10), relief=tk.FLAT, bd=0,
                           insertbackground=self.FG_PRIMARY,
                           height=3, wrap=tk.WORD)
        ai_input.pack(fill=tk.X, side=tk.LEFT, expand=True)
        ai_input.insert(tk.END, "Ask anything... 'Fix a TODO in the codebase'")
        ai_input.config(fg=self.FG_SECONDARY)

        # Model info
        model_frame = self._frame(ai_area, self.BG_AI)
        model_frame.pack(fill=tk.X, padx=16)
        self._label(model_frame, "Build · DSV4 Flash High Thinking dsv4",
                    fg=self.FG_DIM, font=("Consolas", 8)).pack(side=tk.LEFT)
        shortcuts = self._label(model_frame, "tab agents  ctrl+p commands",
                                fg=self.FG_DIM, font=("Consolas", 8))
        shortcuts.pack(side=tk.RIGHT)

        # Tip
        self._label(ai_area,
                    "Tip: Run /init to auto-generate project rules\nbased on your codebase",
                    fg=self.FG_DIM, font=("Consolas", 8),
                    justify=tk.CENTER).pack(pady=(20, 0))

        # Bottom status bar
        status = self._frame(right, self.BG_SIDEBAR)
        status.pack(fill=tk.X, side=tk.BOTTOM)
        status.grid_columnconfigure(0, weight=1)

        self._label(status, "  D:\\AgentTerm\\AT_workspace\\920G-Server",
                    bg=self.BG_SIDEBAR, fg=self.FG_SECONDARY,
                    font=("Consolas", 8)).grid(row=0, column=0, sticky="w", pady=3)
        self._label(status, "6 MCP  /status  ",
                    bg=self.BG_SIDEBAR, fg=self.FG_SECONDARY,
                    font=("Consolas", 8)).grid(row=0, column=1, sticky="e", pady=3)


def main():
    root = tk.Tk()
    # Try to set DPI awareness on Windows
    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass

    app = AgentTermApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()