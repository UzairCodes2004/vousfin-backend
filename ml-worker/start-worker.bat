@echo off
REM Double-click to start the VousFin ML worker.
REM Uses "python -m uvicorn" so it runs under the Python that has the ML libraries
REM (avoids the "No module named lightgbm" two-Python-versions problem).
cd /d "%~dp0"
echo Starting VousFin ML worker on http://localhost:8000  (close this window to stop)
python -m uvicorn app:app --host 0.0.0.0 --port 8000
pause
