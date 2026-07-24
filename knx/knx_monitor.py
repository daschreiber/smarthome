import asyncio, datetime, os, logging
from xknx import XKNX
from xknx.io import ConnectionConfig, ConnectionType

LOG = os.environ['KNX_LOG']
logging.basicConfig(filename=LOG, level=logging.DEBUG,
                    format='%(asctime)s %(name)s %(levelname)s %(message)s')
for noisy in ('xknx.state_updater',):
    logging.getLogger(noisy).setLevel(logging.INFO)

def telegram_cb(telegram):
    logging.getLogger('MONITOR').info(f'TELEGRAM {telegram}')

async def main():
    cc = ConnectionConfig(connection_type=ConnectionType.TUNNELING, gateway_ip='10.0.0.70', gateway_port=3671)
    xknx = XKNX(connection_config=cc)
    xknx.telegram_queue.register_telegram_received_cb(telegram_cb)
    await xknx.start()
    logging.getLogger('MONITOR').info('connected, monitoring')
    await asyncio.sleep(1800)
    await xknx.stop()

asyncio.run(main())
