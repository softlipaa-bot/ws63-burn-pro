/** @type {Record<string, { label: string }>} */
export const FLASH_CHANNELS = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => {
    const id = String(i + 1);
    return [id, { label: `设备 ${id}` }];
  }),
);

export const FLASH_CHANNEL_IDS = Object.keys(FLASH_CHANNELS);
