import * as React from 'react';
import * as ReactDOM from 'react-dom';
import SplitPane from 'react-split-pane';
import { ConsoleComponent, FONT_INFO } from './consoleComponent';

import './style.css';
import spinner from "./spinner.svg";
import { IEvaluateMessage, nextMessageSeq, sendRequestToClient, eventToHandler, IOutputEvent, sendEventToClient, requestToHandler, codeAsHtml } from './vscodeComm';
import { configureMonacoLanguage } from './monacoConf';

declare const initialState: object;  // Set by rfinteractive.ts (in _getHtmlForWebview).

interface ICellInfo {
    id: number
    type: 'code' | 'stdout' | 'stderr' | 'info'
    cellCode: string
    cellCodeHtml: string
}

interface IJsonInfo {
    'target'?: string  //the target robot.yaml (optional)
    'path'?: string  //the path (used for cwd)
    'sys.version'?: string
    'sys.executable'?: string
    'robot.version'?: string
    'initialization.finished'?: boolean  //received when the initialization should be considered complete.
}

interface IJsonInfoContainer {
    jsonInfo: IJsonInfo
}

interface IShowHelpContainer {
    showHelp: boolean
}

interface IHelpComponent extends IJsonInfoContainer, IShowHelpContainer {
    handleToggleHelpContent: () => Promise<void>
}

interface ICellsContainer {
    cells: ICellInfo[]
    jsonInfo: IJsonInfo
}

interface IAppState extends ICellsContainer, IShowHelpContainer {
    showProgress: number
}

interface IHistoryProps extends ICellsContainer {
    showProgress: number
}

interface ICellProps {
    cellInfo: ICellInfo
}

interface IEvaluateRequest {
    uri: string
    code: string
}

class CellComponent extends React.Component<ICellProps> {
    render() {
        let className = "cell_" + this.props.cellInfo.type;
        if (this.props.cellInfo.cellCodeHtml) {
            return <div className={className} dangerouslySetInnerHTML={{ __html: this.props.cellInfo.cellCodeHtml }}></div>;
        } else {
            return <div className={className}>
                <pre className="cell_output_content">
                    {this.props.cellInfo.cellCode}
                </pre>
            </div>
        }
    }
}


let _lastCellId: number = 0;
function nextCellId(): number {
    _lastCellId += 1;
    return _lastCellId;
}

class HelpComponent extends React.Component<IHelpComponent> {
    render() {
        let helpContentClassName = "hidden";
        let showHelp = "More"
        if (this.props.showHelp) {
            helpContentClassName = ""
            showHelp = "Less"
        }
        return (
            <div className="help">
                <a href="#" className="toggleHelp" onClick={this.props.handleToggleHelpContent}>{showHelp}</a>
                <div>
                    <p>INTERACTIVE CONSOLE (ROBOT FRAMEWORK {this.props.jsonInfo['robot.version']}) </p>
                </div>
                <div className={helpContentClassName}>
                    <p>Interactive Console is a REPL for running Robot Framework Code. <br />
                        Try it out by running: <span className="helpExample">Log To Console&nbsp;&nbsp;Hello World</span> <br />
                        <a href="https://github.com/robocorp/robotframework-lsp/blob/master/robotframework-ls/docs/faq.md#how-to-use-the-interactive-console">Learn more »</a></p>
                    <div>Notes:
                        <div>
                            <ul>
                                <li>To use Keywords from Libraries or Resources run first the related <span className="sectionHeader">*** Settings ***</span> block
                                    which imports the needed Library or Resource in the Interactive Console.</li>
                                <li>Start new blocks with a header row, such as <span className="sectionHeader">*** Keywords ***</span>.</li>
                            </ul>
                        </div>
                    </div>

                    <div>
                        Keyboard shortcuts:
                        <div>
                            <ul>
                                <li>Shift-Enter&nbsp;&nbsp;&nbsp;- New Line</li>
                                <li>Enter&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- Run Code</li>
                                <li>Up/Down Arrow - Command history</li>
                            </ul>
                        </div>
                    </div>
                    <div className="helpExample">Python {this.props.jsonInfo['sys.version']}</div>
                    <div className="helpExample">({this.props.jsonInfo['sys.executable']})</div>
                    {this.props.jsonInfo['target'] ? <div className="helpExample">Environment - {this.props.jsonInfo['target']}</div> : undefined}
                    {this.props.jsonInfo['path'] ? <div className="helpExample">Target&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- {this.props.jsonInfo['path']}</div> : undefined}
                </div>
            </div>
        );
    }

}

class HistoryComponent extends React.Component<IHistoryProps> {

    progressRef: any

    constructor(props) {
        super(props)
        this.progressRef = React.createRef();
    }

    render() {
        const cells = this.props.cells.map((cellInfo: ICellInfo) => (
            <CellComponent key={cellInfo.id} cellInfo={cellInfo} />
        ));
        return (
            <div className="history">
                {cells}
                {this.props.showProgress ? <img src={spinner} width="50px;" height="50px;" ref={this.progressRef} /> : null}
            </div>
        );
    }

    componentDidUpdate() {
        if (this.props.showProgress) {
            let curr = this.progressRef.current;
            if (curr) {
                let container = curr.closest(".Pane1");

                if (container.scrollHeight > container.clientHeight) {
                    curr.scrollIntoView({ behavior: 'smooth' });
                }
            }
        }
    }
}


class AppComponent extends React.Component<object, IAppState> {

    constructor(props) {
        super(props);

        let initialShowHelp = true;
        if (initialState !== undefined) {
            if (initialState['showHelp'] !== undefined) {
                initialShowHelp = initialState['showHelp'];
            }
        }
        this.state = {
            cells: [],
            showProgress: 0,
            jsonInfo: {},
            showHelp: initialShowHelp,
        };
        this.handleEvaluate = this.handleEvaluate.bind(this);
        this.handleToggleHelpContent = this.handleToggleHelpContent.bind(this);
        eventToHandler['output'] = this.onEventOutput.bind(this);
        requestToHandler['evaluate'] = this.onRequestEvaluate.bind(this);

        sendEventToClient({
            type: 'event',
            seq: nextMessageSeq(),
            event: 'initialized'
        });
    }

    async onEventOutput(msg: IOutputEvent) {

        this.setState((prevState, props) => {
            if (msg.category == 'json_info') {
                // json_info are internal messages received to provide some information to the
                // console.
                let newJsonInfo: IJsonInfo = JSON.parse(msg.output);
                let jsonInfo: IJsonInfo = { ...prevState.jsonInfo, ...newJsonInfo };
                return { 'jsonInfo': jsonInfo, 'cells': prevState.cells }
            }

            if (!prevState.jsonInfo['initialization.finished']) {
                return; // Ignore any output until the initialization did actually finish
            }

            let type: 'stdout' | 'stderr' | 'info' = 'stdout';
            switch (msg.category) {
                case 'stderr':
                case 'stdout':
                case 'info':
                    type = msg.category;
            }

            if (prevState.cells.length > 0) {
                // Let's see if it should be joined to the last one...
                let lastCell: ICellInfo = prevState.cells[prevState.cells.length - 1];
                if (lastCell.type == type) {
                    lastCell.cellCode += msg.output;
                    return {
                        'jsonInfo': prevState.jsonInfo,
                        'cells': prevState.cells
                    };
                }
            }
            let newCell: ICellInfo = {
                id: nextCellId(),
                type: type,
                cellCode: msg.output,
                cellCodeHtml: undefined
            };
            return {
                'jsonInfo': prevState.jsonInfo,
                'cells': prevState.cells.concat([newCell]),
            };
        });
    }

    // i.e.: VSCode can send something to be evaluated in the webview.
    async onRequestEvaluate(msg: IEvaluateRequest) {
        let code = msg['body'].code;
        await this.handleEvaluate(code, await codeAsHtml(code));
    }

    async handleToggleHelpContent() {
        this.setState((prevState, props) => {
            let msg: IEvaluateMessage = {
                'type': 'request',
                'command': 'persistState',
                'seq': nextMessageSeq(),
                'arguments': {
                    'state': {
                        'showHelp': !prevState.showHelp,
                    }
                }
            };
            sendRequestToClient(msg);

            return {
                'showHelp': !prevState.showHelp
            };
        });
    }

    async handleEvaluate(code: string, codeAsHtml: string) {
        if (!code) {
            return;
        }
        this.setState((prevState, props) => {
            let newCell: ICellInfo = {
                id: nextCellId(),
                type: 'code',
                cellCode: code,
                cellCodeHtml: codeAsHtml,
            };

            return {
                'cells': prevState.cells.concat([newCell]),
                'showProgress': prevState.showProgress + 1
            };
        });

        let msg: IEvaluateMessage = {
            'type': 'request',
            'command': 'evaluate',
            'seq': nextMessageSeq(),
            'arguments': {
                'expression': code,
                'context': 'repl'
            }
        };
        let response = await sendRequestToClient(msg);
        console.log('response', response);

        this.setState((prevState, props) => {
            return {
                'showProgress': prevState.showProgress - 1
            };
        });

    }

    render() {
        return (
            <SplitPane split="horizontal" minSize={50} defaultSize={50} allowResize={true} primary='second'>
                <div>
                    <HelpComponent jsonInfo={this.state.jsonInfo} showHelp={this.state.showHelp} handleToggleHelpContent={this.handleToggleHelpContent} />
                    <HistoryComponent cells={this.state.cells} jsonInfo={this.state.jsonInfo} showProgress={this.state.showProgress} />
                </div>
                <ConsoleComponent handleEvaluate={this.handleEvaluate} />
            </SplitPane>
        );
    }
}

// Create our initial div and render everything inside it.
const e = document.createElement("div");
document.body.appendChild(e);

configureMonacoLanguage();

ReactDOM.render(
    <AppComponent />,
    e
);