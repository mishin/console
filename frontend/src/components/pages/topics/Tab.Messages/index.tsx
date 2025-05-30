/**
 * Copyright 2022 Redpanda Data, Inc.
 *
 * Use of this software is governed by the Business Source License
 * included in the file https://github.com/redpanda-data/redpanda/blob/dev/licenses/bsl.md
 *
 * As of the Change Date specified in that file, in accordance with
 * the Business Source License, use of this software will be governed
 * by the Apache License, Version 2.0
 */

import { ClockCircleOutlined, DeleteOutlined, DownloadOutlined, SettingOutlined } from '@ant-design/icons';
import { DownloadIcon, KebabHorizontalIcon, PlusIcon, SkipIcon, SyncIcon, XCircleIcon } from '@primer/octicons-react';
import { action, autorun, computed, IReactionDisposer, makeObservable, observable, transaction, untracked } from 'mobx';
import { observer } from 'mobx-react';
import React, { Component, FC, ReactNode, useState } from 'react';
import FilterEditor from './Editor';
import filterExample1 from '../../../../assets/filter-example-1.png';
import filterExample2 from '../../../../assets/filter-example-2.png';
import { api, MessageSearchRequest } from '../../../../state/backendApi';
import { Payload, Topic, TopicAction, TopicMessage } from '../../../../state/restInterfaces';
import { Feature, isSupported } from '../../../../state/supportedFeatures';
import {
    ColumnList,
    FilterEntry,
    PartitionOffsetOrigin,
    PreviewTagV2,
    TimestampDisplayFormat
} from '../../../../state/ui';
import { uiState } from '../../../../state/uiState';
import { AnimatePresence, animProps_span_messagesStatus, MotionSpan } from '../../../../utils/animationProps';
import '../../../../utils/arrayExtensions';
import { IsDev } from '../../../../utils/env';
import { FilterableDataSource } from '../../../../utils/filterableDataSource';
import { sanitizeString, wrapFilterFragment } from '../../../../utils/filterHelper';
import { toJson } from '../../../../utils/jsonUtils';
import { editQuery } from '../../../../utils/queryHelper';
import {
    Ellipsis,
    Label,
    navigatorClipboardErrorHandler,
    numberToThousandsString,
    OptionGroup,
    StatusIndicator,
    TimestampDisplay,
    toSafeString
} from '../../../../utils/tsxUtils';
import {
    base64FromUInt8Array,
    cullText,
    encodeBase64,
    prettyBytes,
    prettyMilliseconds,
    titleCase
} from '../../../../utils/utils';
import { range } from '../../../misc/common';
import { KowlJsonView } from '../../../misc/KowlJsonView';
import DeleteRecordsModal from '../DeleteRecordsModal/DeleteRecordsModal';
import { getPreviewTags, PreviewSettings } from './PreviewSettings';
import styles from './styles.module.scss';
import { CollapsedFieldProps } from '@textea/json-viewer';
import {
    Alert,
    AlertDescription,
    AlertIcon,
    AlertTitle,
    Box,
    Button,
    Checkbox,
    DataTable,
    DateTimeInput,
    Empty,
    Flex,
    Grid,
    GridItem,
    Heading,
    Input,
    Link,
    Menu,
    MenuButton,
    MenuItem,
    MenuList,
    Modal,
    ModalBody,
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalOverlay,
    Popover,
    RadioGroup,
    SearchField,
    Switch,
    Tabs as RpTabs,
    Tag,
    TagCloseButton,
    TagLabel,
    Text,
    Tooltip,
    useToast,
    VStack
} from '@redpanda-data/ui';
import { MdExpandMore } from 'react-icons/md';
import { SingleSelect } from '../../../misc/Select';
import { MultiValue, Select as ChakraReactSelect } from 'chakra-react-select';
import { isServerless } from '../../../../config';
import { Link as ReactRouterLink } from 'react-router-dom';
import { appGlobal } from '../../../../state/appGlobal';
import { WarningIcon } from '@chakra-ui/icons';
import { proto3 } from '@bufbuild/protobuf';
import { ColumnDef } from '@tanstack/react-table';
import { CogIcon } from '@heroicons/react/solid';
import { PayloadEncoding } from '../../../../protogen/redpanda/api/console/v1alpha1/common_pb';


interface TopicMessageViewProps {
    topic: Topic;
    refreshTopicData: (force: boolean) => void;
}

/*
    TODO:
        - when the user has entered a specific offset, we should prevent selecting 'all' partitions, as that wouldn't make any sense.
        - add back summary of quick search  <this.FilterSummary />
*/

const getStringValue = (value: string | TopicMessage): string => typeof value === 'string' ? value : JSON.stringify(value, null, 4)

const CopyDropdown: FC<{ record: TopicMessage, onSaveToFile: Function }> = ({ record, onSaveToFile }) => {
    const toast = useToast()
    return (
        <Menu computePositionOnMount>
            <MenuButton as={Button} variant="link" className="iconButton">
                <KebabHorizontalIcon />
            </MenuButton>
            <MenuList>
                <MenuItem disabled={record.key.isPayloadNull} onClick={() => {
                    navigator.clipboard.writeText(getStringValue(record)).then(() => {
                        toast({
                            status: 'success',
                            description: 'Key copied to clipboard'
                        })
                    }).catch(navigatorClipboardErrorHandler)
                }}>
                    Copy Key
                </MenuItem>
                <MenuItem disabled={record.value.isPayloadNull} onClick={() => {
                    navigator.clipboard.writeText(getStringValue(record)).then(() => {
                        toast({
                            status: 'success',
                            description: 'Value copied to clipboard'
                        })
                    }).catch(navigatorClipboardErrorHandler)
                }}>
                    Copy Value
                </MenuItem>
                <MenuItem onClick={() => {
                    navigator.clipboard.writeText(record.timestamp.toString()).then(() => {
                        toast({
                            status: 'success',
                            description: 'Epoch Timestamp copied to clipboard'
                        })
                    }).catch(navigatorClipboardErrorHandler)
                }}>
                    Copy Epoch Timestamp
                </MenuItem>
                <MenuItem onClick={() => onSaveToFile()}>
                    Save to File
                </MenuItem>
            </MenuList>
        </Menu>
    );
};


@observer
export class TopicMessageView extends Component<TopicMessageViewProps> {
    @observable previewDisplay: string[] = [];
    // @observable allCurrentKeys: string[];

    @observable showColumnSettings = false;

    @observable fetchError = null as any | null;

    messageSource = new FilterableDataSource<TopicMessage>(() => api.messages, this.isFilterMatch, 16);

    autoSearchReaction: IReactionDisposer | null = null;
    quickSearchReaction: IReactionDisposer | null = null;

    currentSearchRun: string | null = null;

    @observable downloadMessages: TopicMessage[] | null;
    @observable expandedKeys: React.Key[] = [];

    @observable deleteRecordsModalVisible = false;
    @observable deleteRecordsModalAlive = false;

    constructor(props: TopicMessageViewProps) {
        super(props);
        this.executeMessageSearch = this.executeMessageSearch.bind(this); // needed because we must pass the function directly as 'submit' prop

        makeObservable(this);
    }

    componentDidMount() {
        // unpack query parameters (if any)
        const searchParams = uiState.topicSettings.searchParams;
        const query = new URLSearchParams(window.location.search);
        // console.debug("parsing query: " + toJson(query));
        if (query.has('p')) searchParams.partitionID = Number(query.get('p'));
        if (query.has('s')) searchParams.maxResults = Number(query.get('s'));
        if (query.has('o')) {
            searchParams.startOffset = Number(query.get('o'));
            searchParams.offsetOrigin = (searchParams.startOffset >= 0) ? PartitionOffsetOrigin.Custom : searchParams.startOffset;
        }
        if (query.has('q')) uiState.topicSettings.quickSearch = String(query.get('q'));

        // Auto search when parameters change
        this.autoSearchReaction = autorun(() => this.searchFunc('auto'), { delay: 100, name: 'auto search when parameters change' });

        // Quick search -> url
        this.quickSearchReaction = autorun(() => {
            editQuery(query => {
                if (uiState.topicSettings.quickSearch)
                    query['q'] = uiState.topicSettings.quickSearch;
                else
                    query['q'] = undefined;
            });
        }, { name: 'update query string' });

        this.messageSource.filterText = uiState.topicSettings.quickSearch;
    }
    componentWillUnmount() {
        this.messageSource.dispose();
        if (this.autoSearchReaction)
            this.autoSearchReaction();
        if (this.quickSearchReaction)
            this.quickSearchReaction();
    }

    render() {
        return <>
            <this.SearchControlsBar />

            {/* Message Table (or error display) */}
            {this.fetchError
                ? <Alert status="error">
                    <AlertIcon alignSelf="flex-start" />
                    <Box>
                        <AlertTitle>Backend Error</AlertTitle>
                        <AlertDescription>
                            <Box>Please check and modify the request before resubmitting.</Box>
                            <Box mt="4">
                                <div className="codeBox">{((this.fetchError as Error).message ?? String(this.fetchError))}</div>
                            </Box>
                            <Button mt="4" onClick={() => this.executeMessageSearch()}>
                                Retry Search
                            </Button>
                        </AlertDescription>
                    </Box>
                </Alert>
                : <>
                    <this.MessageTable />
                </>
            }

            {
                this.deleteRecordsModalAlive
                && (
                    <DeleteRecordsModal
                        topic={this.props.topic}
                        visible={this.deleteRecordsModalVisible}
                        onCancel={() => this.deleteRecordsModalVisible = false}
                        onFinish={() => {
                            this.deleteRecordsModalVisible = false;
                            this.props.refreshTopicData(true);
                            this.searchFunc('auto');
                        }}
                        afterClose={() => this.deleteRecordsModalAlive = false}
                    />
                )
            }
        </>;
    }
    SearchControlsBar = observer(() => {
        const searchParams = uiState.topicSettings.searchParams;
        const topic = this.props.topic;
        const spaceStyle = { marginRight: '16px', marginTop: '12px' };
        const canUseFilters = (api.topicPermissions.get(topic.topicName)?.canUseSearchFilters ?? true) && !isServerless();

        const isCompacted = this.props.topic.cleanupPolicy.includes('compact');

        const startOffsetOptions = [
            { value: PartitionOffsetOrigin.End, label: 'Newest' },
            { value: PartitionOffsetOrigin.EndMinusResults, label: 'Newest - ' + String(searchParams.maxResults) },
            { value: PartitionOffsetOrigin.Start, label: 'Oldest' },
            { value: PartitionOffsetOrigin.Custom, label: 'Custom' },
            { value: PartitionOffsetOrigin.Timestamp, label: 'Timestamp' }
        ];

        const isKeyDeserializerActive = uiState.topicSettings.keyDeserializer != PayloadEncoding.UNSPECIFIED && uiState.topicSettings.keyDeserializer != null;
        const isValueDeserializerActive = uiState.topicSettings.valueDeserializer != PayloadEncoding.UNSPECIFIED && uiState.topicSettings.valueDeserializer != null;
        const isDeserializerOverrideActive = isKeyDeserializerActive || isValueDeserializerActive;

        return (
            <React.Fragment>
                <Flex my={4}
                      flexWrap="wrap"
                      alignItems="center"
                >
                    {/* Search Settings*/}
                    <Label text="Partition" style={{ ...spaceStyle, minWidth: '9em' }}>
                        <SingleSelect<number>
                            value={searchParams.partitionID}
                            onChange={c => (searchParams.partitionID = c)}
                            options={[{ value: -1, label: 'All' }].concat(range(0, topic.partitionCount).map(i => ({ value: i, label: String(i) })))}
                        />
                    </Label>
                    <Label text="Start Offset" style={{ ...spaceStyle }}>
                        <>
                            <SingleSelect<PartitionOffsetOrigin> value={searchParams.offsetOrigin} onChange={e => {
                                searchParams.offsetOrigin = e;
                                if (searchParams.offsetOrigin != PartitionOffsetOrigin.Custom)
                                    searchParams.startOffset = searchParams.offsetOrigin;
                            }} options={startOffsetOptions} />
                            {searchParams.offsetOrigin == PartitionOffsetOrigin.Custom && <Input style={{ width: '7.5em' }} maxLength={20} value={searchParams.startOffset} onChange={e => (searchParams.startOffset = +e.target.value)} isDisabled={searchParams.offsetOrigin != PartitionOffsetOrigin.Custom} />}
                            {searchParams.offsetOrigin == PartitionOffsetOrigin.Timestamp && <StartOffsetDateTimePicker />}
                        </>
                    </Label>
                    <Label text="Max Results" style={{ ...spaceStyle, minWidth: '9em' }}>
                        <SingleSelect<number> value={searchParams.maxResults} onChange={c => (searchParams.maxResults = c)} options={[1, 3, 5, 10, 20, 50, 100, 200, 500].map(i => ({ value: i }))} />
                    </Label>

                    {!isServerless() && (
                        <Label text="Filter">
                            <Tooltip label="You don't have permissions to use search filters in this topic"
                                     isDisabled={canUseFilters} placement="top" hasArrow>
                                <Switch size="lg" isChecked={searchParams.filtersEnabled && canUseFilters}
                                        onChange={v => (searchParams.filtersEnabled = v.target.checked)}
                                        isDisabled={!canUseFilters}/>
                            </Tooltip>
                        </Label>
                    )}

                    {/* Refresh Button */}
                    <Label text="" style={{ ...spaceStyle }}>
                        <Flex ml={4}>
                            <AnimatePresence>
                                {api.messageSearchPhase == null && (
                                    <MotionSpan identityKey="btnRefresh" overrideAnimProps={animProps_span_messagesStatus}>
                                        <Tooltip label="Repeat current search" placement="top" hasArrow>
                                            <Button variant="outline" onClick={() => this.searchFunc('manual')}>
                                                <SyncIcon size={16} />
                                            </Button>
                                        </Tooltip>
                                    </MotionSpan>
                                )}
                                {api.messageSearchPhase != null && (
                                    <MotionSpan identityKey="btnCancelSearch" overrideAnimProps={animProps_span_messagesStatus}>
                                        <Tooltip label="Stop searching" placement="top" hasArrow>
                                            <Button variant="solid" colorScheme="red" onClick={() => api.stopMessageSearch()} style={{ padding: 0, width: '48px' }}>
                                                <XCircleIcon size={20} />
                                            </Button>
                                        </Tooltip>
                                    </MotionSpan>
                                )}
                            </AnimatePresence>
                        </Flex>
                    </Label>

                    {/* Topic Actions */}
                    <div className={styles.topicActionsWrapper}>
                        <Menu>
                            <MenuButton as={Button} rightIcon={<MdExpandMore size="1.5rem" />} variant="outline">
                                Actions
                            </MenuButton>
                            <MenuList>
                                <MenuItem
                                    onClick={() => {
                                        appGlobal.history.push(`/topics/${encodeURIComponent(topic.topicName)}/produce-record`);
                                    }}
                                >
                                    Produce Record
                                </MenuItem>
                                {DeleteRecordsMenuItem('2', isCompacted, topic.allowedActions ?? [], () => (this.deleteRecordsModalAlive = this.deleteRecordsModalVisible = true))}
                            </MenuList>
                        </Menu>
                    </div>

                    {/* Quick Search */}
                    <Box>
                        <SearchField width="230px" marginLeft="6" searchText={this.fetchError == null ? uiState.topicSettings.quickSearch : ''} setSearchText={x => (uiState.topicSettings.quickSearch = x)} />
                    </Box>

                    {/* Search Progress Indicator: "Consuming Messages 30/30" */}
                    {Boolean(api.messageSearchPhase && api.messageSearchPhase.length > 0) &&
                        <StatusIndicator
                            identityKey="messageSearch"
                            fillFactor={(api.messages?.length ?? 0) / searchParams.maxResults}
                            statusText={api.messageSearchPhase!}
                            progressText={`${api.messages?.length ?? 0} / ${searchParams.maxResults}`}
                            bytesConsumed={searchParams.filtersEnabled ? prettyBytes(api.messagesBytesConsumed) : undefined}
                            messagesConsumed={searchParams.filtersEnabled ? String(api.messagesTotalConsumed) : undefined}
                        />
                    }

                    {/*
                api.MessageSearchPhase && api.MessageSearchPhase.length > 0 && searchParams.filters.length>0 &&
                    <StatusIndicator
                        identityKey='messageSearch'
                        fillFactor={(api.Messages?.length ?? 0) / searchParams.maxResults}
                        statusText={api.MessageSearchPhase}
                        progressText={`${api.Messages?.length ?? 0} / ${searchParams.maxResults}`}
                        bytesConsumed={searchParams.filtersEnabled ? prettyBytes(api.MessagesBytesConsumed) : undefined}
                        messagesConsumed={searchParams.filtersEnabled ? String(api.MessagesTotalConsumed) : undefined}
                    />
                    */}

                    {/* Filter Tags */}
                    {searchParams.filtersEnabled && (
                        <div style={{ paddingTop: '1em', width: '100%' }}>
                            <MessageSearchFilterBar />
                        </div>
                    )}

                    {/* Show warning if a deserializer is forced for key or value */}
                    {isDeserializerOverrideActive && (
                        <Flex alignItems="flex-end" height="32px" width="100%" gap="4">
                            {isKeyDeserializerActive && <Tag>
                                <TagLabel cursor="pointer" onClick={() => this.showColumnSettings = true}>
                                    Key Deserializer = {proto3.getEnumType(PayloadEncoding).findNumber(uiState.topicSettings.keyDeserializer)?.localName}
                                </TagLabel>
                                <TagCloseButton onClick={() => uiState.topicSettings.keyDeserializer = PayloadEncoding.UNSPECIFIED} />
                            </Tag>}
                            {isValueDeserializerActive && <Tag>
                                <TagLabel cursor="pointer" onClick={() => this.showColumnSettings = true}>
                                    Value Deserializer = {proto3.getEnumType(PayloadEncoding).findNumber(uiState.topicSettings.valueDeserializer)?.localName}
                                </TagLabel>
                                <TagCloseButton onClick={() => uiState.topicSettings.valueDeserializer = PayloadEncoding.UNSPECIFIED} />
                            </Tag>}
                        </Flex>
                    )}
                </Flex>
            </React.Fragment>
        );
    });

    searchFunc = (source: 'auto' | 'manual') => {
        // need to do this first, so we trigger mobx
        const params = uiState.topicSettings.searchParams;
        const searchParams = `${params.offsetOrigin} ${params.maxResults} ${params.partitionID} ${params.startOffset} ${params.startTimestamp}`;

        untracked(() => {
            const phase = api.messageSearchPhase;

            if (searchParams == this.currentSearchRun && source == 'auto') {
                console.log('ignoring serach, search params are up to date, and source is auto', {
                    newParams: searchParams,
                    oldParams: this.currentSearchRun,
                    currentSearchPhase: phase,
                    trigger: source
                });
                return;
            }

            // Abort current search if one is running
            if (phase != 'Done') {
                api.stopMessageSearch();
            }

            console.log('starting a new message search', {
                newParams: searchParams,
                oldParams: this.currentSearchRun,
                currentSearchPhase: phase,
                trigger: source
            });

            // Start new search
            this.currentSearchRun = searchParams;
            try {
                this.executeMessageSearch()
                    .finally(() => {
                        untracked(() => {
                            this.currentSearchRun = null
                        })
                    });

            } catch (err) {
                console.error('error in message search', { error: err });
            }
        });
    };

    cancelSearch = () => api.stopMessageSearch();

    isFilterMatch(str: string, m: TopicMessage) {
        str = uiState.topicSettings.quickSearch.toLowerCase();
        if (m.offset.toString().toLowerCase().includes(str)) return true;
        if (m.keyJson && m.keyJson.toLowerCase().includes(str)) return true;
        if (m.valueJson && m.valueJson.toLowerCase().includes(str)) return true;
        return false;
    }

    @computed
    get activePreviewTags(): PreviewTagV2[] {
        return uiState.topicSettings.previewTags.filter(t => t.isActive);
    }

    MessageTable = observer(() => {
        const [showPreviewSettings, setShowPreviewSettings] = React.useState(false);

        const tsFormat = uiState.topicSettings.previewTimestamps;
        const hasKeyTags = uiState.topicSettings.previewTags.count(x => x.isActive && x.searchInMessageKey) > 0;

        const dataTableColumns: Record<string, ColumnDef<TopicMessage>> = {
            offset: {
                header: 'Offset',
                accessorKey: 'offset',
                cell: ({row: {original: {offset}}}) => numberToThousandsString(offset)
            },
            partitionID: {
                header: 'Partition',
                accessorKey: 'partitionID',
            },
            timestamp: {
                header: 'Timestamp',
                accessorKey: 'timestamp',
                cell: ({row: {original: {timestamp}}}) => <TimestampDisplay unixEpochMillisecond={timestamp} format={tsFormat}/>,
            },
            key: {
                header: 'Key',
                size: hasKeyTags ? 300 : 1,
                accessorKey: 'key',
                cell: ({row: {original}}) => <MessageKeyPreview msg={original} previewFields={() => this.activePreviewTags}/>,
            },
            value: {
                header: () => <span>Value {previewButton}</span>,
                accessorKey: 'value',
                cell: ({row: {original}}) => <MessagePreview msg={original} previewFields={() => this.activePreviewTags} isCompactTopic={this.props.topic.cleanupPolicy.includes('compact')}/>
            },
        }


        const newColumns: ColumnDef<TopicMessage>[] = Object.values(dataTableColumns)

        if(uiState.topicSettings.previewColumnFields.length > 0) {
            newColumns.splice(0, newColumns.length);

            // let's be defensive and remove any duplicates before showing in the table
            new Set(uiState.topicSettings.previewColumnFields.map(field => field.dataIndex)).forEach(dataIndex => {
                if(dataTableColumns[dataIndex]) {
                    newColumns.push(dataTableColumns[dataIndex])
                }
            })
        }

        newColumns[newColumns.length - 1].size = Infinity

        const columns: ColumnDef<TopicMessage>[] = [...newColumns, {
            header: () => <button onClick={() => {
                this.showColumnSettings = true
            }}><CogIcon style={{width: 20}}/>
            </button>,
            id: 'action',
            size: 0,
            cell: ({row: {original}}) => <CopyDropdown record={original} onSaveToFile={() => this.downloadMessages = [original]}/>,
        }]

        const previewButton = <>
            <span style={{ display: 'inline-flex', alignItems: 'center', height: 0, marginLeft: '4px' }}>
                <Button variant="outline" size="sm" className="hoverBorder" onClick={() => setShowPreviewSettings(true)} bg="transparent" px="2" ml="2" lineHeight="0" minHeight="26px">
                    <SettingOutlined style={{ fontSize: '1rem' }} />
                    <span style={{ marginLeft: '.3em' }}>Preview</span>
                    {(() => {
                        const count = uiState.topicSettings.previewTags.sum(t => t.isActive ? 1 : 0);
                        if (count > 0)
                            return <span style={{ marginLeft: '.3em' }}>(<b>{count} active</b>)</span>;
                        return <></>;
                    })()}
                </Button>
            </span>
        </>;

        return <>
            <DataTable<TopicMessage>
                data={this.messageSource.data}
                emptyText="No messages"
                columns={columns}
                showPagination
                subComponent={({row: {original}}) => renderExpandedMessage(original)}
            />
            <Button variant="outline"
                    onClick={() => {
                        this.downloadMessages = api.messages;
                    }}
                    isDisabled={!api.messages || api.messages.length == 0}
            >
                <span style={{paddingRight: '4px'}}><DownloadIcon/></span>
                Save Messages
            </Button>

            <SaveMessagesDialog messages={this.downloadMessages} onClose={() => this.downloadMessages = null}onRequireRawPayload={() => this.executeMessageSearch(true)} />

            {
                (this.messageSource?.data?.length > 0) &&
                <PreviewSettings getShowDialog={() => showPreviewSettings} setShowDialog={s => setShowPreviewSettings(s)}/>
            }

            <ColumnSettings getShowDialog={() => this.showColumnSettings} setShowDialog={s => this.showColumnSettings = s}/>
        </>;
    });



    @action toggleRecordExpand(r: TopicMessage) {
        const key = r.offset + ' ' + r.partitionID + r.timestamp;
        // try collapsing it, removeAll returns the number of matches
        const removed = this.expandedKeys.removeAll(x => x == key);
        if (removed == 0) // wasn't expanded, so expand it now
            this.expandedKeys.push(key);
    }

    async executeMessageSearch(includeRawPayload: boolean = false): Promise<TopicMessage[]> {
        const searchParams = uiState.topicSettings.searchParams;
        const canUseFilters = (api.topicPermissions.get(this.props.topic.topicName)?.canUseSearchFilters ?? true) && !isServerless();

        editQuery(query => {
            query['p'] = String(searchParams.partitionID); // p = partition
            query['s'] = String(searchParams.maxResults); // s = size
            query['o'] = String(searchParams.startOffset); // o = offset
        });

        let filterCode: string = '';
        if (searchParams.filtersEnabled && canUseFilters) {
            const functionNames: string[] = [];
            const functions: string[] = [];

            searchParams.filters.filter(e => e.isActive && e.code && e.transpiledCode).forEach(e => {
                const name = `filter${functionNames.length + 1}`;
                functionNames.push(name);
                functions.push(`function ${name}() {
                    ${wrapFilterFragment(e.transpiledCode)}
                }`);
            });

            if (functions.length > 0) {
                filterCode = functions.join('\n\n') + '\n\n'
                    + `return ${functionNames.map(f => f + '()').join(' && ')}`;
                if (IsDev) console.log(`constructed filter code (${functions.length} functions)`, '\n\n' + filterCode);
            }
        }

        const request = {
            topicName: this.props.topic.topicName,
            partitionId: searchParams.partitionID,
            startOffset: searchParams.startOffset,
            startTimestamp: searchParams.startTimestamp,
            maxResults: searchParams.maxResults,
            filterInterpreterCode: encodeBase64(sanitizeString(filterCode)),
            includeRawPayload: includeRawPayload,

            keyDeserializer: uiState.topicSettings.keyDeserializer,
            valueDeserializer: uiState.topicSettings.valueDeserializer,
        } as MessageSearchRequest;

        // if (typeof searchParams.startTimestamp != 'number' || searchParams.startTimestamp == 0)
        //     console.error("startTimestamp is not valid", { request: request, searchParams: searchParams });

        return transaction(async () => {
            try {
                this.fetchError = null;
                return api.startMessageSearchNew(request).catch(err => {
                    const msg = ((err as Error).message ?? String(err));
                    console.error('error in searchTopicMessages: ' + msg);
                    this.fetchError = err;
                    return [];

                });
            } catch (error: any) {
                console.error('error in searchTopicMessages: ' + ((error as Error).message ?? String(error)));
                this.fetchError = error;
                return [];
            }
        });
    }

    empty = () => {
        const searchParams = uiState.topicSettings.searchParams;
        const filterCount = searchParams.filtersEnabled ? searchParams.filters.filter(x => x.isActive).length : 0;

        const hints: JSX.Element[] = [];
        if (filterCount > 0)
            hints.push(<>There are <b>{filterCount} filters</b> in use by the current search. Keep in mind that messages must pass <b>every</b> filter when using more than one filter at the same time.</>);
        if (searchParams.startOffset == PartitionOffsetOrigin.End)
            hints.push(<><b>Start offset</b> is set to "Newest". Make sure messages are being sent to the topic.</>);

        const hintBox = hints.length ? <ul className={styles.noMessagesHint}>
            {hints.map((x, i) => <li key={i}>{x}</li>)}
        </ul> : null;

        return (
            <VStack gap={4}>
                <Empty description="No messages" />
                {hintBox}
            </VStack>
        );
    };
}

@observer
class SaveMessagesDialog extends Component<{
    messages: TopicMessage[] | null,
    onClose: () => void,
    onRequireRawPayload: () => Promise<TopicMessage[]>
}> {
    @observable isOpen = false;
    @observable format = 'json' as 'json' | 'csv';
    @observable isLoadingRawMessage = false;
    @observable includeRawContent = false;

    radioStyle = { display: 'block', lineHeight: '30px' };

    constructor(p: any) {
        super(p);
        makeObservable(this);
    }

    render() {
        const { messages, onClose } = this.props;
        const count = (messages?.length ?? 0);
        const title = count > 1 ? 'Save Messages' : 'Save Message';

        // Keep dialog open after closing it, so it can play its closing animation
        if (count > 0 && !this.isOpen) setTimeout(() => this.isOpen = true);
        if (this.isOpen && count == 0) setTimeout(() => this.isOpen = false);


        return (
            <Modal isOpen={count > 0} onClose={onClose}>
                <ModalOverlay />
                <ModalContent minW="2xl">
                    <ModalHeader>{title}</ModalHeader>
                    <ModalBody display="flex" flexDirection="column" gap="4">
                        <div>Select the format in which you want to save {count == 1 ? 'the message' : 'all messages'}</div>
                        <Box py={2}>
                            <RadioGroup
                                name="format"
                                value={this.format}
                                onChange={value => this.format = value}
                                options={[
                                    {
                                        value: 'json',
                                        label: 'JSON'
                                    },
                                    {
                                        value: 'csv',
                                        label: 'CSV',
                                        disabled: true
                                    }
                                ]}
                            />
                        </Box>
                        <Checkbox isChecked={this.includeRawContent} onChange={e => this.includeRawContent = e.target.checked}>
                            Include raw data
                        </Checkbox>
                    </ModalBody>
                    <ModalFooter gap={2}>
                        <Button variant="outline" colorScheme="red" onClick={onClose} isDisabled={this.isLoadingRawMessage}>
                            Cancel
                        </Button>
                        <Button variant="solid" onClick={() => this.saveMessages()}
                            isDisabled={this.isLoadingRawMessage}
                            loadingText="Save Messages"
                            isLoading={this.isLoadingRawMessage}
                        >
                            Save Messages
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        )
    }

    async saveMessages() {
        let messages = this.props.messages;
        if (messages == null)
            return;

        try {
            if (this.includeRawContent) {
                const originalUserSelection = [...messages];

                // We do not have the raw content (wasn't requested initially)
                // so we must restart the message search
                this.isLoadingRawMessage = true;
                messages = await this.props.onRequireRawPayload();

                // Here, we do not know whether the user selected to download all messages, or only one.
                // So we need to filter all newly downloaded messages against the original user selection
                messages = messages.filter(m => originalUserSelection.any(x => m.partitionID == x.partitionID && m.offset == x.offset));
            }
        }
        finally {
            this.isLoadingRawMessage = false;
        }

        const cleanMessages = this.cleanMessages(messages);

        const json = toJson(cleanMessages, 4);

        const link = document.createElement('a');
        const file = new Blob([json], { type: 'application/json' });
        link.href = URL.createObjectURL(file);
        link.download = 'messages.json';
        document.body.appendChild(link); // required in firefox
        link.click();

        this.props.onClose();
    }

    cleanMessages(messages: TopicMessage[]): any[] {
        const ar: any[] = [];

        // create a copy of each message, omitting properties that don't make
        // sense for the user, like 'size' or caching properties like 'keyJson'.

        const cleanPayload = function (p: Payload): Payload {
            if (!p) return undefined as any;

            const cleanedPayload = {
                payload: p.payload,
                rawPayload: p.rawBytes ? base64FromUInt8Array(p.rawBytes) : undefined,
                encoding: p.encoding,
            } as any as Payload;

            if (p.schemaId && p.schemaId != 0)
                cleanedPayload.schemaId = p.schemaId;

            return cleanedPayload;
        };

        for (const src of messages) {
            const msg = {} as Partial<typeof src>;

            msg.partitionID = src.partitionID;
            msg.offset = src.offset;
            msg.timestamp = src.timestamp;
            msg.compression = src.compression;
            msg.isTransactional = src.isTransactional;

            msg.headers = src.headers.map(h => ({
                key: h.key,
                value: cleanPayload(h.value),
            }));

            msg.key = cleanPayload(src.key);
            msg.value = cleanPayload(src.value);

            ar.push(msg);
        }

        return ar;
    }
}


@observer
class MessageKeyPreview extends Component<{ msg: TopicMessage, previewFields: () => PreviewTagV2[]; }> {
    render() {
        const msg = this.props.msg;
        const key = msg.key;

        const isPrimitive =
            typeof key.payload === 'string' ||
            typeof key.payload === 'number' ||
            typeof key.payload === 'boolean';
        try {
            if (key.isPayloadNull)
                return renderEmptyIcon('Key is null');
            if (key.payload == null || key.payload.length == 0)
                return null;

            let text: ReactNode = <></>;

            if (key.encoding == 'binary') {
                text = cullText(msg.keyBinHexPreview, 44);
            }
            else if (key.encoding == 'utf8WithControlChars') {
                text = highlightControlChars(key.payload);
            }
            else if (isPrimitive) {
                text = cullText(key.payload, 44);
            }
            else {
                // Only thing left is 'object'
                // Stuff like 'bigint', 'function', or 'symbol' would not have been deserialized
                const previewTags = this.props.previewFields().filter(t => t.searchInMessageValue);
                if (previewTags.length > 0) {
                    const tags = getPreviewTags(key.payload, previewTags);
                    text = <span className="cellDiv fade" style={{ fontSize: '95%' }}>
                        <div className={'previewTags previewTags-' + uiState.topicSettings.previewDisplayMode}>
                            {tags.map((t, i) => <React.Fragment key={i}>{t}</React.Fragment>)}
                        </div>
                    </span>;
                    return text;
                }
                // Normal display (json, no filters). Just stringify the whole object
                text = cullText(JSON.stringify(key.payload), 44);
            }

            return <span className="cellDiv" style={{ minWidth: '10ch', width: 'auto', maxWidth: '45ch' }}>
                <code style={{ fontSize: '95%' }}>{text}</code>
            </span>;
        }
        catch (e) {
            return <span style={{ color: 'red' }}>Error in RenderPreview: {((e as Error).message ?? String(e))}</span>;
        }
    }
}


@observer
class StartOffsetDateTimePicker extends Component {

    constructor(p: any) {
        super(p);
        const searchParams = uiState.topicSettings.searchParams;
        // console.log('time picker 1', { setByUser: searchParams.startTimestampWasSetByUser, startTimestamp: searchParams.startTimestamp, format: new Date(searchParams.startTimestamp).toLocaleDateString() })
        if (!searchParams.startTimestampWasSetByUser) {
            // so far, the user did not change the startTimestamp, so we set it to 'now'
            searchParams.startTimestamp = new Date().getTime();
        }
        // console.log('time picker 2', { setByUser: searchParams.startTimestampWasSetByUser, startTimestamp: searchParams.startTimestamp, format: new Date(searchParams.startTimestamp).toLocaleDateString() })
    }

    render() {
        const searchParams = uiState.topicSettings.searchParams;
        // new Date().getTimezoneOffset()

        return (
            <DateTimeInput
                value={searchParams.startTimestamp}
                onChange={value => {
                    searchParams.startTimestamp = value
                    searchParams.startTimestampWasSetByUser = true;
                }}
            />
        )
    }
}

@observer
class MessagePreview extends Component<{ msg: TopicMessage, previewFields: () => PreviewTagV2[]; isCompactTopic: boolean }> {
    render() {
        const msg = this.props.msg;
        const value = msg.value;

        if (value.troubleshootReport && value.troubleshootReport.length > 0) {
            return <Flex color="red.600" alignItems="center" gap="4">
                <WarningIcon fontSize="1.25em" />
                There were issues deserializing the value
            </Flex>
        }

        if (value.isPayloadTooLarge) {
            return <Flex color="orange.600" alignItems="center" gap="4">
                <WarningIcon fontSize="1.25em" />
                Message content is too large and has been omitted
            </Flex>
        }

        const isPrimitive =
            typeof value.payload === 'string' ||
            typeof value.payload === 'number' ||
            typeof value.payload === 'boolean';

        try {
            let text: ReactNode = <></>;

            if (value.isPayloadNull) {
                if (!this.props.isCompactTopic) {
                    return renderEmptyIcon('Value is null');
                }
                text = <><DeleteOutlined style={{ fontSize: 16, color: 'rgba(0,0,0, 0.35)', verticalAlign: 'text-bottom', marginRight: '4px', marginLeft: '1px' }} /><code>Tombstone</code></>;
            }
            else if (value.encoding == 'null' || value.payload == null || value.payload.length == 0)
                return null;
            else if (msg.value.encoding == 'binary') {
                // If the original data was binary, display as hex dump
                text = msg.valueBinHexPreview;
            }
            else if (isPrimitive) {
                // If we can show the value as a primitive, do so.
                text = value.payload;
            }
            else {
                // Only thing left is 'object'
                // Stuff like 'bigint', 'function', or 'symbol' would not have been deserialized
                const previewTags = this.props.previewFields().filter(t => t.searchInMessageValue);
                if (previewTags.length > 0) {
                    const tags = getPreviewTags(value.payload, previewTags);
                    text = <span className="cellDiv fade" style={{ fontSize: '95%' }}>
                        <div className={'previewTags previewTags-' + uiState.topicSettings.previewDisplayMode}>
                            {tags.map((t, i) => <React.Fragment key={i}>{t}</React.Fragment>)}
                        </div>
                    </span>;
                    return text;

                }
                else {
                    // Normal display (json, no filters). Just stringify the whole object
                    text = cullText(JSON.stringify(value.payload), 300);
                }
            }

            return <code><span className="cellDiv" style={{ fontSize: '95%' }}>{text}</span></code>;
        }
        catch (e) {
            return <span style={{ color: 'red' }}>Error in RenderPreview: {((e as Error).message ?? String(e))}</span>;
        }
    }
}


function renderExpandedMessage(msg: TopicMessage, shouldExpand?: ((x: CollapsedFieldProps) => boolean)) {
    return <div className="expandedMessage">
        <MessageMetaData msg={msg} />
        <RpTabs
            size="lg"
            defaultIndex={1}
            items={[
                {
                    key: 'key',
                    name: <Box minWidth="6rem">Key</Box>,
                    isDisabled: msg.key == null || msg.key.size == 0,
                    component: <>
                        <TroubleshootReportViewer payload={msg.key} />
                        {renderPayload(msg.key, shouldExpand)}
                    </>
                },
                {
                    key: 'value',
                    name: <Box minWidth="6rem">Value</Box>,
                    component: <>
                        <TroubleshootReportViewer payload={msg.value} />
                        {renderPayload(msg.value, shouldExpand)}
                    </>
                },
                {
                    key: 'headers',
                    name: <Box minWidth="6rem">Headers</Box>,
                    isDisabled: msg.headers.length == 0,
                    component: <MessageHeaders msg={msg} />
                },
            ]}
        />
    </div>;
}

function renderPayload(payload: Payload, shouldExpand?: ((x: CollapsedFieldProps) => boolean)) {
    try {
        if (payload === null || payload === undefined || payload.payload === null || payload.payload === undefined)
            return <code>null</code>;

        const val = payload.payload;
        const isPrimitive =
            typeof val === 'string' ||
            typeof val === 'number' ||
            typeof val === 'boolean';

        const shouldCollapse = shouldExpand ? shouldExpand : false;

        if (payload.encoding == 'binary') {
            const mode = 'hex' as ('ascii' | 'raw' | 'hex');
            if (mode == 'raw') {
                return <code style={{ fontSize: '.85em', lineHeight: '1em', whiteSpace: 'normal' }}>{val}</code>;
            }
            else if (mode == 'hex') {
                const rawBytes = payload.rawBytes ?? payload.normalizedPayload;

                if (rawBytes) {
                    let result = '';
                    rawBytes.forEach((n) => {
                        result += n.toString(16).padStart(2, '0') + ' ';
                    });
                    return <code style={{ fontSize: '.85em', lineHeight: '1em', whiteSpace: 'normal' }}>{result}</code>;
                } else {
                    return <div>Raw bytes not available</div>;
                }
            }
            else {
                const str = String(val);
                let result = '';
                const isPrintable = /[\x20-\x7E]/;
                for (let i = 0; i < str.length; i++) {
                    let ch = String.fromCharCode(str.charCodeAt(i)); // str.charAt(i);
                    ch = isPrintable.test(ch) ? ch : '. ';
                    result += ch + ' ';
                }

                return <code style={{ fontSize: '.85em', lineHeight: '1em', whiteSpace: 'normal' }}>{result}</code>;
            }
        }

        // Decode payload from base64 and render control characters as code highlighted text, such as
        // `NUL`, `ACK` etc.
        if (payload.encoding == 'utf8WithControlChars') {
            const elements = highlightControlChars(val);

            return <div className="codeBox">{elements}</div>;
        }

        if (isPrimitive) {
            return <div className="codeBox">{String(val)}</div>;
        }

        return <KowlJsonView src={val} shouldCollapse={shouldCollapse} />;
    }
    catch (e) {
        return <span style={{ color: 'red' }}>Error in RenderExpandedMessage: {((e as Error).message ?? String(e))}</span>;
    }
}

function highlightControlChars(str: string, maxLength?: number): JSX.Element[] {
    const elements: JSX.Element[] = [];
    // To reduce the number of JSX elements we try to append normal chars to a single string
    // until we hit a control character.
    let sequentialChars = '';
    let numChars = 0;

    for (const char of str) {
        const code = char.charCodeAt(0);
        if (code < 32) {
            if (sequentialChars.length > 0) {
                elements.push(<>{sequentialChars}</>)
                sequentialChars = ''
            }
            elements.push(<span className="controlChar">{getControlCharacterName(code)}</span>);
            if (code == 10)
                // LineFeed (\n) should be rendered properly
                elements.push(<br />);

        } else {
            sequentialChars += char;
        }

        if (maxLength != undefined) {
            numChars++;
            if (numChars >= maxLength)
                break;
        }
    }

    if (sequentialChars.length > 0)
        elements.push(<>{sequentialChars}</>);

    return elements;
}

function getControlCharacterName(code: number): string {
    switch (code) {
        case 0: return 'NUL';
        case 1: return 'SOH';
        case 2: return 'STX';
        case 3: return 'ETX';
        case 4: return 'EOT';
        case 5: return 'ENQ';
        case 6: return 'ACK';
        case 7: return 'BEL';
        case 8: return 'BS';
        case 9: return 'HT';
        case 10: return 'LF';
        case 11: return 'VT';
        case 12: return 'FF';
        case 13: return 'CR';
        case 14: return 'SO';
        case 15: return 'SI';
        case 16: return 'DLE';
        case 17: return 'DC1';
        case 18: return 'DC2';
        case 19: return 'DC3';
        case 20: return 'DC4';
        case 21: return 'NAK';
        case 22: return 'SYN';
        case 23: return 'ETB';
        case 24: return 'CAN';
        case 25: return 'EM';
        case 26: return 'SUB';
        case 27: return 'ESC';
        case 28: return 'FS';
        case 29: return 'GS';
        case 30: return 'RS';
        case 31: return 'US';
        default: return '';
    }
};

const TroubleshootReportViewer = observer((props: { payload: Payload; }) => {
    const report = props.payload.troubleshootReport;
    const [show, setShow] = useState(true);

    if (!report) return null;
    if (report.length == 0) return null;

    return <Box mb="4" mt="4">
        <Heading as="h4">Deserialization Troubleshoot Report</Heading>
        <Alert status="error" variant="subtle" my={4} flexDirection="column" background="red.50">
            <AlertTitle display="flex" flexDirection="row" alignSelf="flex-start" alignItems="center" pb="4" fontWeight="normal">
                <AlertIcon /> Errors were encoutnered when deserializing this message
                <Link pl="2" onClick={() => setShow(!show)} >{show ? 'Hide' : 'Show'}</Link>
            </AlertTitle>
            <AlertDescription whiteSpace="pre-wrap" display={show ? undefined : 'none'}>
                <Grid templateColumns="auto 1fr" rowGap="1" columnGap="4">
                    {report.map(e => <>
                        <GridItem key={e.serdeName + '-name'} w="100%" fontWeight="bold" textTransform="capitalize" py="2" px="5" pl="8">
                            {e.serdeName}
                        </GridItem>
                        <GridItem key={e.serdeName + '-message'} w="100%" fontFamily="monospace" background="red.100" py="2" px="5">
                            {e.message}
                        </GridItem>
                    </>)}
                </Grid>
            </AlertDescription>

        </Alert>


    </Box>

});

const MessageMetaData = observer((props: { msg: TopicMessage; }) => {
    const msg = props.msg;
    const data: { [k: string]: any } = {
        'Key': msg.key.isPayloadNull ? 'Null' : `${titleCase(msg.key.encoding)} (${prettyBytes(msg.key.size)})`,
        'Value': msg.value.isPayloadNull ? 'Null' : `${titleCase(msg.value.encoding)} (${msg.value.schemaId > 0 ? `${msg.value.schemaId} / ` : ''}${prettyBytes(msg.value.size)})`,
        'Headers': msg.headers.length > 0 ? `${msg.headers.length}` : 'No headers set',
        'Compression': msg.compression,
        'Transactional': msg.isTransactional ? 'true' : 'false',
        // "Producer ID": "(msg.producerId)",
    };

    if (msg.value.schemaId) {
        data['Schema'] = <MessageSchema schemaId={msg.value.schemaId} />
    }

    return <div style={{ display: 'flex', flexWrap: 'wrap', fontSize: '0.75rem', gap: '1em 3em', color: 'rgba(0, 0, 0, 0.8)', margin: '1em 0em 1.5em .3em' }}>
        {Object.entries(data).map(([k, v]) => <React.Fragment key={k}>
            <div style={{ display: 'flex', rowGap: '.4em', flexDirection: 'column', fontFamily: 'Open Sans' }}>
                <div style={{ fontWeight: 600 }}>{k}</div>
                <div style={{ color: 'rgba(0, 0, 0, 0.6)', }}>{v}</div>
            </div>
        </React.Fragment>)}
    </div>;
});

const MessageSchema = observer((p: { schemaId: number }) => {

    const subjects = api.schemaUsagesById.get(p.schemaId);
    if (!subjects || subjects.length == 0) {
        api.refreshSchemaUsagesById(p.schemaId);
        return <>
            ID {p.schemaId} (unknown subject)
        </>;
    }

    const s = subjects[0];
    return <>
        <Link as={ReactRouterLink} to={`/schema-registry/subjects/${encodeURIComponent(s.subject)}?version=${s.version}`}>
            {s.subject} (version {s.version})
        </Link>
    </>
});

const MessageHeaders = observer((props: { msg: TopicMessage; }) => {
    return <div className="messageHeaders">
        <div>
            <DataTable<{key: string, value: Payload}>
                data={props.msg.headers}
                columns={[
                    {
                        size: 200, header: 'Key', accessorKey: 'key',
                        cell: ({row: {original: {key: headerKey}}}) => <span className="cellDiv" style={{ width: 'auto' }}>
                            {headerKey
                                ? <Ellipsis>{toSafeString(headerKey)}</Ellipsis>
                                : renderEmptyIcon('Empty Key')}
                        </span>
                    },
                    {
                        size: Infinity, header: 'Value', accessorKey: 'value',
                        cell: ({row: {original: {value: headerValue}}}) => {
                            if (typeof headerValue.payload === 'undefined') return renderEmptyIcon('"undefined"');
                            if (headerValue.payload === null) return renderEmptyIcon('"null"');
                            if (typeof headerValue.payload === 'number') return <span>{String(headerValue.payload)}</span>;

                            if (typeof headerValue.payload === 'string')
                                return <span className="cellDiv">{headerValue.payload}</span>;

                            // object
                            return <span className="cellDiv">{toSafeString(headerValue.payload)}</span>;
                        },
                    },
                    {
                        size: 120, header: 'Encoding', accessorKey: 'value',
                        cell: ({row: {original: {value: payload}}}) => <span className="nowrap">{payload.encoding}</span>
                    },
                ]}
                subComponent={({row: {original: header}}) => {
                    return typeof header.value?.payload !== 'object'
                        ? <div className="codeBox" style={{ margin: '0', width: '100%' }}>{toSafeString(header.value.payload)}</div>
                        : <KowlJsonView src={header.value.payload as object} style={{ margin: '2em 0' }} />
                }}
            />
        </div>
    </div>;
});


const ColumnSettings: FC<{ getShowDialog: () => boolean; setShowDialog: (val: boolean) => void }> = observer(({ getShowDialog, setShowDialog }) => {

    const payloadEncodingPairs = [
        { value: PayloadEncoding.UNSPECIFIED, label: 'Automatic' },
        { value: PayloadEncoding.NULL, label: 'None (Null)' },
        { value: PayloadEncoding.AVRO, label: 'AVRO' },
        { value: PayloadEncoding.PROTOBUF, label: 'Protobuf' },
        { value: PayloadEncoding.PROTOBUF_SCHEMA, label: 'Protobuf Schema' },
        { value: PayloadEncoding.JSON, label: 'JSON' },
        { value: PayloadEncoding.JSON_SCHEMA, label: 'JSON Schema' },
        { value: PayloadEncoding.XML, label: 'XML' },
        { value: PayloadEncoding.TEXT, label: 'Plain Text' },
        { value: PayloadEncoding.UTF8, label: 'UTF-8' },
        { value: PayloadEncoding.MESSAGE_PACK, label: 'Message Pack' },
        { value: PayloadEncoding.SMILE, label: 'Smile' },
        { value: PayloadEncoding.BINARY, label: 'Binary' },
        { value: PayloadEncoding.UINT, label: 'Unsigned Int' },
        { value: PayloadEncoding.CONSUMER_OFFSETS, label: 'Consumer Offsets' },
    ];


    return <Modal isOpen={getShowDialog()} onClose={() => {
        setShowDialog(false);
    }}>
        <ModalOverlay />
        <ModalContent minW="4xl">
            <ModalHeader>
                Column Settings
            </ModalHeader>
            <ModalCloseButton />
            <ModalBody>
                <Box mb="1em">
                    <Text mb={2}>Key Deserializer</Text>
                    <Box>
                        <SingleSelect
                            options={payloadEncodingPairs}
                            value={uiState.topicSettings.keyDeserializer}
                            onChange={e => uiState.topicSettings.keyDeserializer = e}
                        />
                    </Box>

                    <Text mb={2}>Value Deserializer</Text>
                    <Box>
                        <SingleSelect
                            options={payloadEncodingPairs}
                            value={uiState.topicSettings.valueDeserializer}
                            onChange={e => uiState.topicSettings.valueDeserializer = e}
                        />
                    </Box>
                </Box>
                <Box>
                    <Text>
                        Click on the column field on the text field and/or <b>x</b> on to remove it.<br />
                    </Text>
                </Box>
                <Box py={6} px={4} bg="rgba(200, 205, 210, 0.16)" borderRadius="4px">
                    <ColumnOptions tags={uiState.topicSettings.previewColumnFields} />
                </Box>
                <Box mt="1em">
                    <Text mb={2}>More Settings</Text>
                    <Box>
                        <OptionGroup<TimestampDisplayFormat>
                            label="Timestamp"
                            options={{
                                'Local DateTime': 'default',
                                'Unix DateTime': 'unixTimestamp',
                                'Relative': 'relative',
                                'Local Date': 'onlyDate',
                                'Local Time': 'onlyTime',
                                'Unix Millis': 'unixMillis',
                            }}
                            value={uiState.topicSettings.previewTimestamps}
                            onChange={e => uiState.topicSettings.previewTimestamps = e}
                        />
                    </Box>
                </Box>
            </ModalBody>
            <ModalFooter gap={2}>
                <Button onClick={() => {
                    setShowDialog(false)
                }} colorScheme="red">Close</Button>
            </ModalFooter>
        </ModalContent>
    </Modal>
});


const handleColumnListChange = action((newValue: MultiValue<{ value: string, label: string }>) => {
    uiState.topicSettings.previewColumnFields = newValue.map(({label, value}) => ({
        title: label,
        dataIndex: value
    }))
})


const ColumnOptions: FC<{ tags: ColumnList[] }> = ({ tags }) => {
    const defaultColumnList: ColumnList[] = [
        { title: 'Offset', dataIndex: 'offset' },
        { title: 'Partition', dataIndex: 'partitionID' },
        { title: 'Timestamp', dataIndex: 'timestamp' },
        { title: 'Key', dataIndex: 'key' },
        // { title: 'Headers', dataIndex: 'headers' },
        { title: 'Value', dataIndex: 'value' },
        { title: 'Size', dataIndex: 'size' }, // size of the whole message is not available (bc it was a bad guess), might be added back later
    ];

    const value = tags.map(column => ({
        label: column.title,
        value: column.dataIndex
    }));

    return <ChakraReactSelect<{label: string; value: string}, true>
        isMulti={true}
        name=""
        options={defaultColumnList.map((column: ColumnList) => ({
            label: column.title,
            value: column.dataIndex,
        }))}
        value={value}
        onChange={handleColumnListChange}
    />
}

const makeHelpEntry = (title: string, content: ReactNode, popTitle?: string): ReactNode => (
    <Popover key={title} trigger="click" hideCloseButton title={popTitle} content={<Box maxW="600px">{content}</Box>} size="auto">
        <Button variant="link" size="small" style={{ fontSize: '1.2em' }}>
            {title}
        </Button>
    </Popover>
);

// TODO Explain:
// - multiple filters are combined with &&
// - 'return' is optional if you only have an expression! as is ';'
// - more examples for 'value', along with 'find(...)'
const helpEntries = [
    makeHelpEntry('Basics', <ul style={{ margin: 0, paddingInlineStart: '15px' }}>
        <li>The filter code is a javascript function body (click 'parameters' to see what arguments are available)</li>
        <li>Return true to allow a message, return false to discard the message.</li>
        <li>You can omit the 'return' keyword if your filter is just an 'expression'</li>
        <li>If you have multiple active filters, they're combined with 'and'. Meaning that ALL filters a message is tested on must return true for it to be passed to the frontend.</li>
        <li>The context is re-used between messages, but every partition has its own context</li>
    </ul>),
    makeHelpEntry('Parameters', <ul style={{ margin: 0, paddingInlineStart: '15px' }}>
        <li><span className="codeBox">offset</span> (number)</li>
        <li><span className="codeBox">partitionID</span> (number)</li>
        <li><span className="codeBox">key</span> (string)</li>
        <li><span className="codeBox">value</span> (object)</li>
        <li><span className="codeBox">headers</span> (object)</li>
    </ul>),
    makeHelpEntry('Examples', <ul style={{ margin: 0, paddingInlineStart: '15px' }}>
        <li style={{ margin: '1em 0' }}><span className="codeBox">offset &gt; 10000</span></li>
        <li style={{ margin: '1em 0' }}><span className="codeBox">value != null</span> Skips tombstone messages</li>
        <li style={{ margin: '1em 0' }}><span className="codeBox">if (key == 'example') return true</span></li>
        <li style={{ margin: '1em 0' }}><span className="codeBox">headers.myVersionHeader &amp;&amp; (headers.myVersionHeader &gt;&eq; 2)</span> Only messages that have a header entry like {'{key: "myVersionHeader", "value:" 12345}'}</li>
        <li style={{ margin: '1em 0' }}><span className="codeBox">return (partitionID == 2) &amp;&amp; (value.someProperty == 'test-value')</span></li>
        <li style={{ margin: '1em 0' }}><div style={{ border: '1px solid #ccc', borderRadius: '4px' }}><img src={filterExample1} alt="Filter Example 1" loading="lazy" /></div></li>
        <li style={{ margin: '1em 0' }}><div style={{ border: '1px solid #ccc', borderRadius: '4px' }}><img src={filterExample2} alt="Filter Example 2" loading="lazy" /></div></li>
    </ul>),
].genericJoin((_last, _cur, curIndex) => <div key={'separator_' + curIndex} style={{ display: 'inline', borderLeft: '1px solid #0003' }} />);

@observer
class MessageSearchFilterBar extends Component {
    /*
    todo:
        - does a click outside of the editor mean "ok" or "cancel"?
            - maybe don't allow closing by clicking outside?
            - ok: so we can make quick changes
        - maybe submit the code live, show syntax errors below
        - maybe havee a button that runs the code against the newest message?
     */

    @observable currentFilter: FilterEntry | null = null;
    currentFilterBackup: string | null = null; // json of 'currentFilter'
    currentIsNew = false; // true: 'onCancel' must remove the filter again

    @observable hasChanges = false; // used by editor; shows "revert changes" when true

    constructor(p: any) {
        super(p);
        makeObservable(this);
    }

    render() {
        const settings = uiState.topicSettings.searchParams;

        return <div className={styles.filterbar}>


            <div className={styles.filters}>
                {/* Existing Tags List  */}
                {settings.filters?.map(e =>
                    <Tag
                        style={{ userSelect: 'none' }}
                        className={e.isActive ? 'filterTag' : 'filterTag filterTagDisabled'}
                        key={e.id}
                    >
                        <SettingOutlined
                            className="settingIconFilter"
                            onClick={() => {
                                this.currentIsNew = false;
                                this.currentFilterBackup = toJson(e);
                                this.currentFilter = e;
                                this.hasChanges = false;
                            }}
                        />
                        <TagLabel onClick={() => e.isActive = !e.isActive}
                            mx="2"
                            height="100%"
                            display="inline-flex"
                            alignItems="center"
                            border="0px solid hsl(0 0% 85% / 1)"
                            borderWidth="0px 1px"
                            px="6px"
                            textDecoration={e.isActive ? '' : 'line-through'}
                        >
                            {e.name ? e.name : (e.code ? e.code : 'New Filter')}
                        </TagLabel>
                        <TagCloseButton onClick={() => settings.filters.remove(e)} m="0" px="1" opacity={1} />
                    </Tag>
                )}

                {/* Add Filter Button */}
                <Tag onClick={() => transaction(() => {
                    this.currentIsNew = true;
                    this.currentFilterBackup = null;
                    this.currentFilter = new FilterEntry();
                    this.hasChanges = false;
                    settings.filters.push(this.currentFilter);
                })}>
                    <span style={{ cursor: 'pointer' }}>
                        <PlusIcon size="small" />
                    </span>
                    {/* <span>New Filter</span> */}
                </Tag>
            </div>

            {api.messageSearchPhase === null || api.messageSearchPhase === 'Done'
                ? (
                    <div className={styles.metaSection}>
                        <span><DownloadOutlined className={styles.bytesIcon} /> {prettyBytes(api.messagesBytesConsumed)}</span>
                        <span className={styles.time}><ClockCircleOutlined className={styles.timeIcon} /> {api.messagesElapsedMs ? prettyMilliseconds(api.messagesElapsedMs) : ''}</span>
                    </div>
                )
                : (
                    <div className={`${styles.metaSection} ${styles.isLoading}`}>
                        <span className={`spinner ${styles.spinner}`} />
                        <span className={`pulsating ${styles.spinnerText}`}>Fetching data...</span>
                    </div>
                )
            }


            <Modal isOpen={this.currentFilter !== null} onClose={() => this.currentFilter = null}>
                <ModalOverlay />
                <ModalContent minW="4xl">
                    <ModalHeader>
                        Edit Filter
                    </ModalHeader>
                    <ModalBody>
                        {this.currentFilter && <Flex gap={4} flexDirection="column">
                            <Label text="Display Name">
                                <Input
                                    style={{ padding: '2px 8px' }}
                                    value={this.currentFilter!.name}
                                    onChange={e => {
                                        this.currentFilter!.name = e.target.value;
                                        this.hasChanges = true;
                                    }}
                                    placeholder="will be shown instead of the code"
                                    size="small" />
                            </Label>

                            {/* Code Box */}
                            <Label text="Filter Code">
                                <FilterEditor
                                    value={this.currentFilter!.code}
                                    onValueChange={(code, transpiled) => {
                                        this.currentFilter!.code = code;
                                        this.currentFilter!.transpiledCode = transpiled;
                                        this.hasChanges = true;
                                    }}
                                />
                            </Label>

                            {/* Help Bar */}
                            <Text fontSize="sm" color="gray.700" fontWeight={300}>Help: {helpEntries}</Text>

                        </Flex>}
                    </ModalBody>
                    <ModalFooter>
                        <Box display="flex" gap={4} alignItems="center" justifyContent="flex-end">
                            <Text fontSize="xs" color="gray.500">
                                Changes are saved automatically
                            </Text>
                            {this.hasChanges && <Button variant="outline" colorScheme="red" onClick={() => this.revertChanges()}>Revert Changes</Button>}
                            <Button onClick={() => this.currentFilter = null}>Close</Button>
                        </Box>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </div>;
    }

    revertChanges() {
        if (this.currentFilter && this.currentFilterBackup) {
            const restored = JSON.parse(this.currentFilterBackup);
            if (restored)
                Object.assign(this.currentFilter, restored);
            this.hasChanges = false;
        }
    }
}

function renderEmptyIcon(tooltipText?: string) {
    if (!tooltipText) tooltipText = 'Empty';
    return (
        <Tooltip label={tooltipText} openDelay={1} placement="top" hasArrow>
            <span style={{ opacity: 0.66, marginLeft: '2px' }}>
                <SkipIcon />
            </span>
        </Tooltip>
    );
}

function hasDeleteRecordsPrivilege(allowedActions: Array<TopicAction>) {
    return allowedActions.includes('deleteTopicRecords') || allowedActions.includes('all');
}

function DeleteRecordsMenuItem(key: string, isCompacted: boolean, allowedActions: Array<TopicAction>, onClick: () => void) {
    const isEnabled = !isCompacted && hasDeleteRecordsPrivilege(allowedActions) && isSupported(Feature.DeleteRecords);

    let errorText: string | undefined;
    if (isCompacted) errorText = 'Records on Topics with the \'compact\' cleanup policy cannot be deleted.';
    else if (!hasDeleteRecordsPrivilege(allowedActions)) errorText = 'You\'re not permitted to delete records on this topic.';
    else if (!isSupported(Feature.DeleteRecords)) errorText = 'The cluster doesn\'t support deleting records.';

    let content: JSX.Element | string = 'Delete Records';
    if (errorText)
        content = (
            <Tooltip label={errorText} placement="top" hasArrow>
                {content}
            </Tooltip>
        );

    return (
        <MenuItem key={key} isDisabled={!isEnabled} onClick={onClick}>
            {content}
        </MenuItem>
    );
}
