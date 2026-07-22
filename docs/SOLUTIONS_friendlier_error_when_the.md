# worker/src/connection_analyzer.py (or relevant module)

import re
from typing import Tuple, Optional

def analyze_connection_error(
    raw_error: str, 
    requested_port: int, 
    target_host: Optional[str] = "localhost"
) -> Tuple[Optional[str], str]:
    """
    Analyzes a raw connection error message to generate user-friendly troubleshooting advice.

    If the reported target uses 'localhost' (127.0.0.1), it checks for Docker context 
    and upgrades the suggested hostname to 'host.docker.internal'.

    Args:
        raw_error: The raw connection failure string (e.g., "Connection refused to localhost:3000").
        requested_port: The port number that was attempted.
        target_host: The original host name specified in the attempt (default 'localhost').

    Returns:
        A tuple containing: 
        1. The clean, suggested connection string for the user.
        2. The detailed, formatted troubleshooting message.
    """
    
    # --- Core Logic Start ---
    
    suggested_host = target_host
    formatted_error = raw_error

    # 1. Context Detection: Is this error highly likely to originate inside Docker?
    # We make a heuristic assumption based on the combination of localhost failure and container context.
    is_docker_context_suspicious = (
        target_host in ("localhost", "127.0.0.1") and 
        "connection refused" in raw_error.lower()
    )

    if is_docker_context_suspicious:
        # Found the trap! Update the suggested host for Docker containers.
        suggested_host = "host.docker.internal"
        
        # Use regex replacement to update all instances of 'localhost'/'127.0.0.1' 
        # in the reported error string for consistency.
        formatted_error = re.sub(r'(?:localhost|127\.0\.0\.1)', suggested_host, raw_error)

    # --- Formatting and Documentation ---

    if is_docker_context_suspicious:
        documentation = (
            "💡 **Docker Context Advisory:** "
            "When running within Docker containers, `localhost` refers to the container's internal loopback interface. "
            "If your service is running on the host machine (the machine running Docker), you must use the special DNS name: "
            f"`{suggested_host}:{requested_port}` instead of `localhost:{requested_port}`."
        )
    else:
        documentation = (
            "ℹ️ **Standard Connection Error:** The error suggests a connection failure to the specified host/port. "
            "Please ensure that a service is actively listening at this address or check firewall rules."
        )

    final_report = (
        f"\n\n✨ **🛠️ Actionable Suggestion:**\n"
        f"   * Try updating your target URL to: `{suggested_host}:{requested_port}`.\n"
        f"{documentation}"
    )

    return suggested_host, formatted_error + final_report.strip()
