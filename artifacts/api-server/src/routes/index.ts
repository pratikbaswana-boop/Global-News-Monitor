import { Router, type IRouter } from "express";
import healthRouter from "./health";
import newsRouter from "./news";
import intelligenceRouter from "./intelligence";
import pushRouter from "./push";
import chatRouter from "./chat";
import authRouter from "./auth";
import engagementRouter from "./engagement";
import brokerRouter from "./broker";
import tradingRouter from "./trading";

const router: IRouter = Router();

router.use(healthRouter);
router.use(newsRouter);
router.use(intelligenceRouter);
router.use(pushRouter);
router.use(chatRouter);
router.use(authRouter);
router.use(engagementRouter);
router.use(brokerRouter);
router.use(tradingRouter);

export default router;
