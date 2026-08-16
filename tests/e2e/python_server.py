import sys

import uvicorn

from research_service.app import create_app


if __name__ == "__main__":
    uvicorn.run(create_app(sys.argv[1]), host="127.0.0.1", port=int(sys.argv[2]), log_level="error")
