#!/usr/bin/env python3
"""
Standalone hardware validation script for the GY-AS3935 clone, step 1 of
the lightning sensor integration (see handoff notes). NOT wired into
node_helper.js yet - run this manually first to confirm calibration and
real IRQ events (lightning/disturber/noise) before building the daemon.

Usage:
    python3 test_calibrate.py [--indoor/--outdoor] [--noise-floor N]
                               [--tuning-cap N] [--speed HZ] [--irq-gpio N]

Ctrl+C to stop.
"""
import argparse
import sys
import time

import spidev
import RPi.GPIO as GPIO

from as3935_spi import AS3935SPI

REG_NAMES = {0x01: "too much noise", 0x04: "disturber", 0x08: "lightning"}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bus", type=int, default=0)
    p.add_argument("--device", type=int, default=0, help="CS0=0 (GPIO8/pin24, matches wiring doc)")
    p.add_argument("--speed", type=int, default=500000, help="SPI clock Hz, datasheet max is 2MHz")
    p.add_argument("--irq-gpio", type=int, default=17, help="BCM pin, matches wiring doc")
    p.add_argument("--indoor", dest="indoor", action="store_true", default=True)
    p.add_argument("--outdoor", dest="indoor", action="store_false")
    p.add_argument("--noise-floor", type=int, default=2, help="0-7, lower = more sensitive")
    p.add_argument("--watchdog-threshold", type=int, default=2, help="0-10, higher = less sensitive to weak disturbers")
    p.add_argument("--tuning-cap", type=int, default=None, help="0-15, only if no factory-cal sticker")
    p.add_argument("--min-strikes", type=int, default=1, choices=[1, 5, 9, 16])
    p.add_argument("--mask-disturber", action="store_true", help="hide disturber events (leave off for this test)")
    args = p.parse_args()

    spi = spidev.SpiDev()
    spi.open(args.bus, args.device)
    spi.mode = 1  # AS3935 requires SPI mode 1 (CPOL=0, CPHA=1)
    spi.max_speed_hz = args.speed

    sensor = AS3935SPI(spi)

    print(f"Raw reg0x00 before reset: 0x{sensor.read_reg(0x00):02x}")

    sensor.reset()
    sensor.set_indoors(args.indoor)
    sensor.set_noise_floor(args.noise_floor)
    sensor.set_watchdog_threshold(args.watchdog_threshold)
    sensor.set_min_strikes(args.min_strikes)
    sensor.set_mask_disturber(args.mask_disturber)

    print(f"Calibrating (indoor={args.indoor}, noise_floor={args.noise_floor}, "
          f"tuning_cap={args.tuning_cap}, min_strikes={args.min_strikes})...")
    sensor.calibrate(tun_cap=args.tuning_cap)
    print("Calibration done.")
    print(f"Post-calibration reg0x00=0x{sensor.read_reg(0x00):02x} "
          f"reg0x01=0x{sensor.read_reg(0x01):02x} reg0x08=0x{sensor.read_reg(0x08):02x}")

    GPIO.setmode(GPIO.BCM)
    GPIO.setup(args.irq_gpio, GPIO.IN, pull_up_down=GPIO.PUD_DOWN)

    def on_irq(channel):
        # Datasheet: wait >=2ms after IRQ pin asserts before reading the
        # interrupt reason register, or you can read a stale/garbage value.
        time.sleep(0.003)
        reason = sensor.get_interrupt()
        label = REG_NAMES.get(reason, f"unknown(0x{reason:02x})")
        ts = time.strftime("%H:%M:%S")
        if reason == 0x08:
            distance = sensor.get_distance()
            energy = sensor.get_energy()
            print(f"[{ts}] LIGHTNING  distance={distance}km energy={energy}")
        elif reason == 0x04:
            print(f"[{ts}] disturber")
        elif reason == 0x01:
            print(f"[{ts}] noise (consider raising --noise-floor)")
        else:
            print(f"[{ts}] {label}")

    GPIO.add_event_detect(args.irq_gpio, GPIO.RISING, callback=on_irq, bouncetime=50)

    print(f"Listening on IRQ GPIO{args.irq_gpio}. Tap/scratch near the antenna to "
          f"simulate a disturber, or Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        GPIO.cleanup()
        spi.close()
        print("\nStopped, GPIO cleaned up.")


if __name__ == "__main__":
    sys.exit(main())
