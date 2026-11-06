# homebridge-kettle-pro

Homebridge plugin for Fellow Stagg kettles. Supports:
- **Stagg EKG Pro** on firmware 1.2.26 over Wi-Fi (native HTTP API)
- **Stagg EKG Pro** on firmware 1.1.x over Wi-Fi (HTTP CLI API)
- **Stagg EKG+ / EKG Pro** over BLE bridge HTTP API (legacy)

Fork of [calvinmclean/homebridge-kettle](https://github.com/calvinmclean/homebridge-kettle).

## Install

```
npm install -g homebridge-kettle-pro
```

## Config

```json
"platforms": [
    {
        "platform": "StaggKettle",
        "name": "Kettles",
        "kettles": [
            {
                "name": "Kettle",
                "connection": "native",
                "url": "http://192.168.1.32",
                "minTemp": 40,
                "maxTemp": 100
            }
        ]
    }
]
```

Each entry in `kettles` becomes one accessory in HomeKit.

| Field | Required | Description |
|---|---|---|
| `name` | yes | Name shown in HomeKit |
| `connection` | yes | `"native"` for EKG Pro firmware 1.2.26, `"wifi"` for EKG Pro firmware 1.1.x (CLI), `"ble"` for BLE bridge |
| `url` | yes | Base URL of the kettle (Wi-Fi) or bridge (BLE). No trailing slash. |
| `minTemp` | no | Minimum target temp in °C (default: 40) |
| `maxTemp` | no | Maximum target temp in °C (default: 100) |
| `pollInterval` | no | `native` only: seconds between background reads (default: 15, minimum: 5) |

## Connection types

Which firmware is the kettle running? `http://<kettle>/` shows `Current version`.

### Wi-Fi native API (`connection: "native"`)
For firmware 1.2.26, which mutes the CLI: `/cli` answers with its input form only, so the `wifi` connection gets nothing to read and HomeKit reads time out. This connection reads the kettle's `/temp` JSON every `pollInterval` seconds and answers HomeKit from the last reading, and sets the target temperature through the settings record at `/api` (read back to confirm).

Limits of firmware 1.2.26 over Wi-Fi:
- **No on/off.** The firmware has no Wi-Fi power command, so switching the kettle on or off from HomeKit is refused; use the kettle itself or the Fellow app.
- **Wi-Fi pauses while heating or holding.** HomeKit keeps the last known state until the kettle answers again (one warning in the log when it stops answering, one info line when it's back).

Firmware 1.2.24 has neither a working CLI nor this API. Wire formats follow [bramboe/stagg-ekg-plus-ha](https://github.com/bramboe/stagg-ekg-plus-ha).

### Wi-Fi CLI (`connection: "wifi"`)
Talks directly to the EKG Pro's built-in HTTP CLI (`/cli?cmd=...`). Requires firmware that supports `setstate` and `setsetting settempr` (1.1.x; 1.2.24 and later mute the CLI's output).

### BLE bridge (`connection: "ble"`)
Talks to the legacy [stagg-ekg-plus](https://github.com/calvinmclean/stagg-ekg-plus) Python bridge via `/state`, `/current_temp`, `/target_temp`.

## Homebridge UI

A config schema is included — use the graphical form in Homebridge Config UI X to configure the plugin.
