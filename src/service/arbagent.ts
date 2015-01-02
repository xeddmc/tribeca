/// <reference path="../common/models.ts" />
/// <reference path="config.ts" />
/// <reference path="utils.ts" />

import Config = require("./config");
import Models = require("../common/models");
import Utils = require("./utils");
import Interfaces = require("./interfaces");
import Quoter = require("./quoter");

// computes theoretical values based off the market and theo parameters
export class FairValueAgent {
    public NewValue = new Utils.Evt();
    public latestFairValue : Models.FairValue = null;

    constructor(private _broker : Interfaces.IBroker) {
        _broker.MarketData.on(this.recalcMarkets);
    }

    private recalcMarkets = () => {
        var mkt = this._broker.currentBook;

        if (mkt != null) {
            var mid = (mkt.asks[0].price + mkt.bids[0].price) / 2.0;

            var newFv = new Models.FairValue(mid, mkt);
            var previousFv = this.latestFairValue;
            if (!FairValueAgent.fairValuesAreSame(newFv, previousFv)) {
                this.latestFairValue = newFv;
                this.NewValue.trigger();
            }
        }
    };

    private static fairValuesAreSame(newFv : Models.FairValue, previousFv : Models.FairValue) {
        if (previousFv == null && newFv != null) return false;
        return Math.abs(newFv.price - previousFv.price) < 1e-3;
    }
}

export class QuotingParametersRepository {
    private _log : Utils.Logger = Utils.log("tribeca:qpr");
    NewParameters = new Utils.Evt();

    private _latest = new Models.QuotingParameters(.2, .01);
    public get latest() : Models.QuotingParameters {
        return this._latest;
    }

    public updateParameters = (newParams : Models.QuotingParameters) => {
        if (Math.abs(this.latest.width - newParams.width) > 1e-4 || Math.abs(this.latest.size - newParams.size) > 1e-4) {
            this._latest = newParams;
            this._log("Changed parameters width=%d size=%d", this.latest.width, this.latest.size);
            this.NewParameters.trigger();
        }
    };
}

// computes a quote based off my quoting parameters
export class QuoteGenerator {
    NewQuote = new Utils.Evt();
    public latestQuote : Models.TwoSidedQuote = null;

    constructor(private _qlParamRepo : QuotingParametersRepository,
                private _fvAgent : FairValueAgent) {
        this._fvAgent.NewValue.on(this.handleNewFairValue);
        this._qlParamRepo.NewParameters.on(this.handleNewFairValue);
    }

    private handleNewFairValue = () => {
        var fv = this._fvAgent.latestFairValue;

        if (fv != null) {
            var params = this._qlParamRepo.latest;
            var width = params.width;
            var size = params.size;

            var bidPx = Math.max(fv.price - width, 0);
            var askPx = fv.price + width;

            var t = Utils.date(); // TODO: this is obviously incorrect
            var bidQuote = new Models.Quote(Models.QuoteAction.New, Models.Side.Bid, t, bidPx, size);
            var askQuote = new Models.Quote(Models.QuoteAction.New, Models.Side.Ask, t, askPx, size);

            this.latestQuote = new Models.TwoSidedQuote(bidQuote, askQuote);
            this.NewQuote.trigger();
        }
    };
}

// makes decisions about whether or not a quote should be submitted
export class Trader {
    private _log : Utils.Logger = Utils.log("tribeca:trader");
    public Active : boolean = false;
    public ActiveChanged = new Utils.Evt();
    public latestDecision : Models.TradingDecision = null;
    public NewTradingDecision = new Utils.Evt<Models.TradingDecision>();

    changeActiveStatus = (to : boolean) => {
        if (this.Active != to) {
            this.Active = to;
            this._log("changing active status to %o", to);

            this.sendQuote();
            this.ActiveChanged.trigger(this.Active);
        }
    };

    constructor(private _broker : Interfaces.IBroker,
                private _quoteGenerator : QuoteGenerator,
                private _quoter : Quoter.Quoter) {
        this._quoteGenerator.NewQuote.on(this.sendQuote);
    }

    private sendQuote = () : void => {
        var quote = this._quoteGenerator.latestQuote;

        if (quote === null) {
            return;
        }

        var bidQt : Models.Quote = null;
        var askQt : Models.Quote = null;

        if (this.Active && this.isBrokerActive()) {
            bidQt = quote.bid;
            askQt = quote.ask;
        }
        else {
            bidQt = Trader.ConvertToStopQuote(quote.ask);
            askQt = Trader.ConvertToStopQuote(quote.bid);
        }

        var askAction = this._quoter.updateQuote(askQt);
        var bidAction = this._quoter.updateQuote(bidQt);

        var decision = new Models.TradingDecision(bidAction, askAction);
        this.latestDecision = decision;
        this.NewTradingDecision.trigger(decision);
        this._log("New trading decision: %s from quote %s", decision.toString(), quote.toString());
    };

    private static ConvertToStopQuote(q : Models.Quote) {
        return new Models.Quote(Models.QuoteAction.Cancel, q.side, q.time);
    }

    private isBrokerActive = () : boolean => {
        return this._broker.connectStatus == Models.ConnectivityStatus.Connected;
    };

    private hasEnoughPosition = (b : Interfaces.IBroker, cur : Models.Currency, minAmt : number) : boolean => {
        var pos = b.getPosition(cur);
        return pos != null && pos.amount > minAmt;
    };
}