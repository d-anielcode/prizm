from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Step:
    name: str
    chain: str
    kind: str                     # 'http' | 'python' | 'check'
    target: str = ''              # route path+query, script path (relative to scripts/), or check name
    date_offset: int = 0          # 0 = today (ET), -1 = yesterday
    critical: bool = False        # failure skips the rest of its chain
    readiness: Optional[str] = None
    coverage: Optional[str] = None
    skip_if: Optional[str] = None
