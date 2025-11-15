from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import doctor


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Configuration utilities for document-locator.")
    subparsers = parser.add_subparsers(dest="command")

    doctor_parser = subparsers.add_parser("doctor", help="Validate configuration sources.")
    doctor_parser.add_argument("--env-file", type=Path, help="Path to the .env file to read.")
    doctor_parser.add_argument(
        "--config-file", type=Path, help="Path to the user config file (config.toml)."
    )

    args = parser.parse_args(argv)
    if args.command == "doctor":
        success = doctor(env_file=args.env_file, config_file=args.config_file)
        return 0 if success else 1

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
