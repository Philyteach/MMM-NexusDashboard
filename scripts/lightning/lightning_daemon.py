#!/usr/bin/env python3
"""
Long-running AS3935 lightning sensor daemon. Calibrates once at startup,
then listens on the IRQ GPIO pin for the rest of its life and emits one
JSON object per line to stdout per event - spawned and read the same way
node_helper.js already spawns/reads rtl_433 (see lib/LightningSensorClient.js).

stdout is pure JSON, one object per line, so node_helper's line parser
never has to guess what's a reading and what's a log line:
    {"type": "ready"}
    {"type": "lightning", "distance_km": 5, "energy": 133527, "ts": 1735000000123}
    {"type": "disturber", "ts": 1735000000123}
    {"type": "noise", "ts": 1735000000123}
All human-readable logging goes to stderr instead.

Default --noise-floor/--watchdog-threshold (7/10) were tuned against a
real board sitting on a breadboard right next to a Pi 4 - at the AS3935's
factory defaults (2/2) that placement produces hundreds of false
disturber/noise events per second from the Pi's own switching regulators
and USB traffic. 7/10 was the first setting that held a clean baseline
(zero spurious events over 20s) while still reliably catching a real
tap/scratch test on the antenna. Override via flags if the sensor ends up
mounted further from RF noise sources (e.g. the school deployment).
"""
import argparse
import json
import sys
import time

import spidev
import RPi.GPIO as GPIO

from as3935_spi import AS3935SPI

IRQ_REASON = {0x01: "noise", 0x04: "disturber", 0x08: "lightning"}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(obj):
    print(json.dumps(obj), flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bus", type=int, default=0)
    p.add_argument("--device", type=int, default=0, help="CS0=0 (GPIO8/pin24)")
    p.add_argument("--speed", type=int, default=500000)
    p.add_argument("--irq-gpio", type=int, default=17, help="BCM pin")
    p.add_argument("--indoor", dest="indoor", action="store_true", default=True)
    p.add_argument("--outdoor", dest="indoor", action="store_false")
    p.add_argument("--noise-floor", type=int, default=7, help="0-7, tuned for a Pi-adjacent breadboard - see module docstring")
    p.add_argument("--watchdog-threshold", type=int, default=10, help="0-10, see module docstring")
    p.add_argument("--min-strikes", type=int, default=1, choices=[1, 5, 9, 16])
    p.add_argument("--mask-disturber", action="store_true")
    p.add_argument("--tuning-cap", type=int, default=None, help="0-15, only if the board has no factory-cal sticker")
    args = p.parse_args()

    try:
        spi = spidev.SpiDev()
        spi.open(args.bus, args.device)
        spi.mode = 1  # AS3935 requires SPI mode 1 (CPOL=0, CPHA=1)
        spi.max_speed_hz = args.speed
    except Exception as err:
        log(f"Failed to open SPI bus {args.bus} device {args.device}: {err}")
        sys.exit(1)

    sensor = AS3935SPI(spi)

    log(f"Calibrating (indoor={args.indoor}, noise_floor={args.noise_floor}, "
        f"watchdog_threshold={args.watchdog_threshold}, tuning_cap={args.tuning_cap}, "
        f"min_strikes={args.min_strikes})...")
    sensor.reset()
    sensor.set_indoors(args.indoor)
    sensor.set_noise_floor(args.noise_floor)
    sensor.set_watchdog_threshold(args.watchdog_threshold)
    sensor.set_min_strikes(args.min_strikes)
    sensor.set_mask_disturber(args.mask_disturber)
    sensor.calibrate(tun_cap=args.tuning_cap)
    log("Calibration done.")

    GPIO.setmode(GPIO.BCM)
    GPIO.setup(args.irq_gpio, GPIO.IN, pull_up_down=GPIO.PUD_DOWN)

    def on_irq(channel):
        # Datasheet: wait >=2ms after the IRQ pin asserts before reading
        # the interrupt reason register, or the value can be stale.
        time.sleep(0.003)
        reason_bits = sensor.get_interrupt()
        reason = IRQ_REASON.get(reason_bits)
        ts = int(time.time() * 1000)
        if reason == "lightning":
            distance = sensor.get_distance()
            energy = sensor.get_energy()
            emit({"type": "lightning", "distance_km": distance, "energy": energy, "ts": ts})
        elif reason == "disturber":
            emit({"type": "disturber", "ts": ts})
        elif reason == "noise":
            emit({"type": "noise", "ts": ts})
        # An unrecognized reason_bits value (0x00, or a stale/garbage read)
        # means nothing actually happened - not a real event, don't emit.

    GPIO.add_event_detect(args.irq_gpio, GPIO.RISING, callback=on_irq, bouncetime=50)

    emit({"type": "ready"})
    log(f"Listening on IRQ GPIO{args.irq_gpio}.")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        GPIO.cleanup()
        spi.close()
        log("Stopped, GPIO cleaned up.")


if __name__ == "__main__":
    main()
