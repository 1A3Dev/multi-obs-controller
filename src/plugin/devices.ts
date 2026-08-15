const deviceTypes = new Map<string, number>();

$SD.onConnected(({ appInfo }: any) => {
	for (const device of appInfo?.devices ?? []) deviceTypes.set(device.id, device.type);
});

$SD.onDeviceDidConnect(({ device, deviceInfo }: any) => {
	if (deviceInfo?.type !== undefined) deviceTypes.set(device, deviceInfo.type);
});

export function getDeviceType(deviceId: string): number | undefined {
	return deviceTypes.get(deviceId);
}
