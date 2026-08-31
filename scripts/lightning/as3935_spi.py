"""
Minimal AS3935 driver over SPI.

The only AS3935 Python libraries available on piwheels/PyPI (RPi_AS3935,
as3935) are I2C-only (smbus / pigpio i2c_open) - this board is wired for
SPI (see the SI pin, tied to GND), so neither works as-is. The register
map is identical between the two transports though, so this ports
RPi_AS3935's register logic (https://pypi.org/project/RPi-AS3935/,
pcfens/RPi-AS3935 on GitHub) straight across, swapping smbus calls for
the SPI framing in AS3935 datasheet section "SPI Timing/Interface":
  read:  xfer2([0x40 | reg, 0x00])[1]   (bit6 set = read)
  write: xfer2([reg & 0x3F, value])     (bit6 clear = write)
Confirmed against real hardware: reading reg 0x00 raw returned 0x24 (36
decimal), which is the AS3935's documented power-on default for that
register - so this framing is correct for this board.
"""
import time

READ = 0x40


class AS3935SPI:
    def __init__(self, spi, registers_to_cache=9):
        self.spi = spi
        self._reg_count = registers_to_cache
        self.registers = [0] * self._reg_count

    def read_data(self):
        self.registers = [self.read_reg(r) for r in range(self._reg_count)]

    def read_reg(self, reg):
        return self.spi.xfer2([READ | (reg & 0x3F), 0x00])[1]

    def set_byte(self, reg, value):
        self.spi.xfer2([reg & 0x3F, value & 0xFF])

    def calibrate(self, tun_cap=None):
        """Blocking, takes ~a few ms. tun_cap 0-15 sets the internal tuning
        caps (0-120pF in 8pF steps) if the board has no factory-cal sticker."""
        time.sleep(0.08)
        self.read_data()
        if tun_cap is not None:
            if not (0 <= tun_cap < 0x10):
                raise ValueError("tun_cap must be 0-15")
            self.set_byte(0x08, (self.registers[0x08] & 0xF0) | tun_cap)
            time.sleep(0.002)
        self.set_byte(0x3D, 0x96)  # CALIB_RCO
        time.sleep(0.002)
        self.read_data()
        self.set_byte(0x08, self.registers[0x08] | 0x20)  # DISP_SRCO on
        time.sleep(0.002)
        self.set_byte(0x08, self.registers[0x08] & 0xDF)  # DISP_SRCO off
        time.sleep(0.002)

    def reset(self):
        self.set_byte(0x3C, 0x96)  # PRESET_DEFAULT
        time.sleep(0.002)

    def get_interrupt(self):
        """0x01 noise, 0x04 disturber, 0x08 lightning. Caller must wait
        >=2ms after the IRQ pin fires before calling this (datasheet)."""
        self.read_data()
        return self.registers[0x03] & 0x0F

    def get_distance(self):
        self.read_data()
        val = self.registers[0x07] & 0x3F
        return False if val == 0x3F else val

    def get_energy(self):
        self.read_data()
        return ((self.registers[0x06] & 0x1F) << 16) | (self.registers[0x05] << 8) | self.registers[0x04]

    def get_noise_floor(self):
        self.read_data()
        return (self.registers[0x01] & 0x70) >> 4

    def set_noise_floor(self, level):
        self.read_data()
        write_data = (self.registers[0x01] & 0x8F) | ((level & 0x07) << 4)
        self.set_byte(0x01, write_data)

    def get_watchdog_threshold(self):
        self.read_data()
        return self.registers[0x01] & 0x0F

    def set_watchdog_threshold(self, level):
        """0-10 (datasheet range), higher = less sensitive to weak/near
        disturbers. Distinct from noise_floor: that's the RF noise floor
        comparator, this is the strike-shape rejection classifier."""
        self.read_data()
        write_data = (self.registers[0x01] & 0xF0) | (level & 0x0F)
        self.set_byte(0x01, write_data)

    def set_min_strikes(self, minstrikes):
        mapping = {1: 0, 5: 1, 9: 2, 16: 3}
        if minstrikes not in mapping:
            raise ValueError("minstrikes must be 1, 5, 9, or 16")
        self.read_data()
        write_data = (self.registers[0x02] & 0xCF) | ((mapping[minstrikes] & 0x03) << 4)
        self.set_byte(0x02, write_data)

    def set_indoors(self, indoors):
        self.read_data()
        write_value = (self.registers[0x00] & 0xC1) | (0x24 if indoors else 0x1C)
        self.set_byte(0x00, write_value)

    def set_mask_disturber(self, mask):
        self.read_data()
        write_value = (self.registers[0x03] | 0x20) if mask else (self.registers[0x03] & 0xDF)
        self.set_byte(0x03, write_value)
