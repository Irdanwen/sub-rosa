"""Loads the service configuration."""
import configparser
from pathlib import Path


def load(path=Path(__file__).with_name("app.ini")):
    parser = configparser.ConfigParser()
    parser.read(path)
    return {
        "server": {
            "host": parser["server"]["host"],
            "port": parser["server"].getint("port"),
            "workers": parser["server"].getint("workers"),
        },
        "database": {
            "url": parser["database"]["url"],
            "pool_size": parser["database"].getint("pool_size"),
            "timeout_seconds": parser["database"].getfloat("timeout_seconds"),
        },
        "features": {
            "exports": parser["features"].getboolean("exports"),
            "beta_dashboard": parser["features"].getboolean("beta_dashboard"),
        },
    }


if __name__ == "__main__":
    print(load())
