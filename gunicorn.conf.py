import multiprocessing
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '10000')}"
workers = max(2, multiprocessing.cpu_count() // 2)
threads = 2
worker_class = "gthread"
keepalive = 5
preload_app = False
accesslog = "-"
errorlog = "-"
loglevel = "info"
