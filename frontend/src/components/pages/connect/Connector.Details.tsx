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

import { useEffect, useState } from 'react';
import { observer, useLocalObservable } from 'mobx-react';
import { comparer } from 'mobx';
import { appGlobal } from '../../../state/appGlobal';
import { api } from '../../../state/backendApi';
import { ClusterConnectorInfo, ClusterConnectorTaskInfo, ConnectorError, DataType, PropertyImportance } from '../../../state/restInterfaces';
import { Code } from '../../../utils/tsxUtils';
import { PageComponent, PageInitHelper } from '../Page';
import { ConnectClusterStore } from '../../../state/connect/state';
import { ConfigPage } from './dynamic-ui/components';
import './helper';
import { ConfirmModal, NotConfigured, statusColors, TaskState } from './helper';
import PageContent from '../../misc/PageContent';
import { delay } from '../../../utils/utils';
import { Button, Alert, AlertIcon, Box, CodeBlock, Flex, Grid, Heading, Tabs, Text, useDisclosure, Modal as RPModal, ModalOverlay, ModalContent, ModalHeader, ModalCloseButton, ModalBody, ModalFooter, Tooltip, Skeleton, DataTable } from '@redpanda-data/ui';
import Section from '../../misc/Section';
import React from 'react';
import { getConnectorFriendlyName } from './ConnectorBoxCard';

export type UpdatingConnectorData = { clusterName: string; connectorName: string };
export type RestartingTaskData = { clusterName: string; connectorName: string; taskId: number };
interface LocalConnectorState {
    pausingConnector: ClusterConnectorInfo | null;
    restartingConnector: ClusterConnectorInfo | null;
    updatingConnector: UpdatingConnectorData | null;
    restartingTask: RestartingTaskData | null;
    deletingConnector: string | null;
}
const KafkaConnectorMain = observer(
    ({
        clusterName,
        connectorName,
        refreshData,
    }: {
        clusterName: string;
        connectorName: string;
        refreshData: (force: boolean) => Promise<void>;
    }) => {
        const [connectClusterStore] = useState(ConnectClusterStore.getInstance(clusterName));

        useEffect(() => {
            const init = async () => {
                await connectClusterStore.setup();
            };
            init();
        }, [connectClusterStore]);

        const $state = useLocalObservable<LocalConnectorState>(() => ({
            pausingConnector: null,
            restartingConnector: null,
            updatingConnector: null,
            restartingTask: null,
            deletingConnector: null,
        }));
        if (!connectClusterStore.isInitialized) {
            return <Skeleton mt={5} noOfLines={20} height={4} />
        }

        const connectorStore = connectClusterStore.getConnectorStore(connectorName);

        const connector = connectClusterStore.getRemoteConnector(connectorName);

        const canEdit = connectClusterStore.canEdit;
        if (!connector) return null;

        return <>
            {/* [Pause] [Restart] [Delete] */}
            <Flex flexDirection="row" alignItems="center" gap="3">

                {/* [Pause/Resume] */}
                {connectClusterStore.validateConnectorState(connectorName, ['RUNNING', 'PAUSED']) ? (
                    <Tooltip placement="top" isDisabled={canEdit !== true} label={'You don\'t have \'canEditConnectCluster\' permissions for this connect cluster'} hasArrow={true}>
                        <Button disabled={!canEdit} onClick={() => ($state.pausingConnector = connector)} variant="outline" minWidth="32">
                            {connectClusterStore.validateConnectorState(connectorName, ['RUNNING']) ? 'Pause' : 'Resume'}
                        </Button>
                    </Tooltip>
                ) : null}

                {/* [Restart] */}
                <Tooltip placement="top" isDisabled={canEdit !== true} label={'You don\'t have \'canEditConnectCluster\' permissions for this connect cluster'} hasArrow={true}>
                    <Button disabled={!canEdit} onClick={() => ($state.restartingConnector = connector)} variant="outline" minWidth="32">
                        Restart
                    </Button>
                </Tooltip>

                {/* [Delete] */}
                <Tooltip placement="top" isDisabled={canEdit !== true} label={'You don\'t have \'canEditConnectCluster\' permissions for this connect cluster'} hasArrow={true}>
                    <Button variant="outline" colorScheme="red" disabled={!canEdit} onClick={() => ($state.deletingConnector = connectorName)} minWidth="32">
                        Delete
                    </Button>
                </Tooltip>
            </Flex>

            <Tabs marginBlock="2"
                size="lg"
                items={[
                    {
                        key: 'overview',
                        name: 'Overview',
                        component: <Box mt="8">
                            <ConfigOverviewTab clusterName={clusterName} connectClusterStore={connectClusterStore} connector={connector}/>
                        </Box>
                    },
                    {
                        key: 'configuration',
                        name: 'Configuration',
                        component: <Box mt="8">
                            <Box maxWidth="800px">
                                <ConfigPage connectorStore={connectorStore} context="EDIT" />
                            </Box>

                            {/* Update Config Button */}
                            <Flex m={4} mb={6}>
                                <Tooltip placement="top" isDisabled={canEdit !== true} label={'You don\'t have \'canEditConnectCluster\' permissions for this connect cluster'} hasArrow={true}>
                                    <Button
                                        variant="outline"
                                        style={{width: '200px'}}
                                        disabled={(() => {
                                            if (!canEdit) return true;
                                            if (!connector) return true;
                                            if (comparer.shallow(connector.config, connectorStore.getConfigObject())) return true;
                                        })()}
                                        onClick={() => {
                                            $state.updatingConnector = {clusterName, connectorName};
                                        }}
                                    >
                                        Update Config
                                    </Button>
                                </Tooltip>
                            </Flex>
                        </Box>
                    }
                ]}
            />


            {/* Pause/Resume Modal */}
            <ConfirmModal<ClusterConnectorInfo>
                target={() => $state.pausingConnector}
                clearTarget={() => ($state.pausingConnector = null)}
                content={(c) => (
                    <>
                        {connectClusterStore.validateConnectorState(connectorName, ['RUNNING']) ? 'Pause' : 'Resume'} connector{' '}
                        <strong>{c.name}</strong>?
                    </>
                )}
                successMessage={(c) => (
                    <>
                        {connectClusterStore.validateConnectorState(connectorName, ['RUNNING']) ? 'Resumed' : 'Paused'} connector{' '}
                        <strong>{c.name}</strong>
                    </>
                )}
                onOk={async (c) => {
                    if (connectClusterStore.validateConnectorState(connectorName, ['RUNNING']))
                        await api.pauseConnector(clusterName, c.name);
                    else await api.resumeConnector(clusterName, c.name);
                    await delay(500);
                    await refreshData(true);
                }}
            />

            {/* Restart */}
            <ConfirmModal<ClusterConnectorInfo>
                target={() => $state.restartingConnector}
                clearTarget={() => ($state.restartingConnector = null)}
                content={(c) => (
                    <>
                        Restart connector <strong>{c.name}</strong>?
                    </>
                )}
                successMessage={(c) => (
                    <>
                        Successfully restarted connector <strong>{c.name}</strong>
                    </>
                )}
                onOk={async (c) => {
                    await api.restartConnector(clusterName, c.name);
                    await refreshData(true);
                }}
            />

            {/* Update Config */}
            <ConfirmModal<UpdatingConnectorData>
                target={() => $state.updatingConnector}
                clearTarget={() => ($state.updatingConnector = null)}
                content={(c) => (
                    <>
                        Update configuration of connector <strong>{c.connectorName}</strong>?
                    </>
                )}
                successMessage={(c) => (
                    <>
                        Successfully updated config of <strong>{c.connectorName}</strong>
                    </>
                )}
                onOk={async (c) => {
                    connectClusterStore.getConnectorStore(c.connectorName);
                    await connectClusterStore.updateConnnector(c.connectorName);
                    appGlobal.history.push(`/connect-clusters/${encodeURIComponent(clusterName)}`);
                    await refreshData(true);
                }}
            />

            {/* Restart Task */}
            <ConfirmModal<RestartingTaskData>
                target={() => $state.restartingTask}
                clearTarget={() => ($state.restartingTask = null)}
                content={(c) => (
                    <>
                        Restart task <strong>{c.taskId}</strong> of <strong>{c.connectorName}</strong>?
                    </>
                )}
                successMessage={(c) => (
                    <>
                        Successfully restarted <strong>{c.taskId}</strong> of <strong>{c.connectorName}</strong>
                    </>
                )}
                onOk={async (c) => {
                    await api.restartTask(c.clusterName, c.connectorName, c.taskId);
                    await refreshData(true);
                }}
            />

            {/* Delete Connector */}
            <ConfirmModal<string>
                target={() => $state.deletingConnector}
                clearTarget={() => ($state.deletingConnector = null)}
                content={(c) => (
                    <>
                        Delete connector <strong>{c}</strong>?
                    </>
                )}
                successMessage={(c) => (
                    <>
                        Deleted connector <strong>{c}</strong>
                    </>
                )}
                onOk={async (_connectorName) => {
                    await connectClusterStore.deleteConnector(connectorName);
                    appGlobal.history.push(`/connect-clusters/${encodeURIComponent(clusterName)}`);
                    await refreshData(true);
                }}
            />
        </>

    }
);

const ConfigOverviewTab = observer((p: {
    clusterName: string,
    connectClusterStore: ConnectClusterStore,
    connector: ClusterConnectorInfo,
}) => {
    const { connectClusterStore, connector } = p;
    const connectorName = connector.name;

    return <>
        <Grid
            templateAreas={`
                "errors errors"
                "health details"
                "tasks details"
            `}
            gridTemplateRows="auto"
            alignItems="start"
            gap="6"
        >
            <Flex gridArea="errors" flexDirection="column" gap="2">
                {connector.errors.map(e => <ConnectorErrorModal key={e.title} error={e} />)}
            </Flex>

            <Section gridArea="health">
                <Flex flexDirection="row" gap="4" m="1">
                    <Box width="5px" borderRadius="3px" background={statusColors[connector.status]} />

                    <Flex flexDirection="column">
                        <Text fontWeight="semibold" fontSize="3xl">{connector.status}</Text>
                        <Text opacity=".5">Status</Text>
                    </Flex>
                </Flex>
            </Section>

            <Section py={4} gridArea="tasks" minWidth="500px">
                <Flex alignItems="center" mt="2" mb="6" gap="2">
                    <Heading as="h3" fontSize="1rem" fontWeight="semibold" textTransform="uppercase" color="blackAlpha.800">
                        Tasks
                    </Heading>
                    <Text opacity=".5" fontWeight="normal">({connectClusterStore.getConnectorTasks(connectorName)?.length || 0})</Text>
                </Flex>
                <DataTable<ClusterConnectorTaskInfo>
                    data={connectClusterStore.getConnectorTasks(connectorName) ?? []}
                    defaultPageSize={10}
                    showPagination
                    columns={[
                        {
                            header: 'Task',
                            accessorKey: 'taskId',
                            size: 200,
                            cell: ({row: {original: {taskId}}}) => <Code nowrap>Task-{taskId}</Code>,
                        },
                        {
                            header: 'Status',
                            accessorKey: 'state',
                            cell: ({row: {original}}) => <TaskState observable={original} />,
                        },
                        {
                            header: 'Worker',
                            accessorKey: 'workerId',
                            cell: ({row: {original}}) => <Code nowrap>{original.workerId}</Code>,
                        }
                    ]}
                />
            </Section>

            <Section py={4} gridArea="details">
                <Heading as="h3" mb="6" mt="2" fontSize="1rem" fontWeight="semibold" textTransform="uppercase" color="blackAlpha.800">
                    Connector Details
                </Heading>

                <ConnectorDetails clusterName={p.clusterName} connectClusterStore={connectClusterStore} connector={connector} />
            </Section>
        </Grid>

    </>
});

const ConnectorErrorModal = observer((p: { error: ConnectorError }) => {
    const { isOpen, onOpen, onClose } = useDisclosure();

    const errorType = p.error.type == 'ERROR'
        ? 'error'
        : 'warning';

    const hasConnectorLogs = api.topics?.any(x => x.topicName == '__redpanda.connectors_logs');

    return <>
        <Alert status={errorType} variant="solid" height="12" borderRadius="8px" onClick={onOpen}>
            <AlertIcon />
            {p.error.title}
            <Button ml="auto" variant="ghost" colorScheme="gray" size="sm" mt="1px">View details</Button>
        </Alert>

        <RPModal onClose={onClose} size="6xl" isOpen={isOpen}>
            <ModalOverlay />
            <ModalContent>
                <ModalHeader>{p.error.title}</ModalHeader>
                <ModalCloseButton />
                <ModalBody>
                    <CodeBlock language="json" codeString={p.error.content} showScroll={false} />
                </ModalBody>
                <ModalFooter gap={2}>
                    {hasConnectorLogs &&
                        <Button onClick={() => appGlobal.history.push('/topics/__redpanda.connectors_logs')} mr="auto">
                            Show Logs
                        </Button>}
                    <Button onClick={onClose}>Close</Button>
                </ModalFooter>
            </ModalContent>
        </RPModal>
    </>
});

@observer
class KafkaConnectorDetails extends PageComponent<{ clusterName: string; connector: string }> {
    initPage(p: PageInitHelper): void {
        const clusterName = decodeURIComponent(this.props.clusterName);
        const connector = decodeURIComponent(this.props.connector);
        p.title = connector;
        p.addBreadcrumb('Connectors', '/connect-clusters');
        p.addBreadcrumb(clusterName, `/connect-clusters/${encodeURIComponent(clusterName)}`);
        p.addBreadcrumb(connector, `/connect-clusters/${encodeURIComponent(clusterName)}/${encodeURIComponent(connector)}`);
        this.refreshData(true);
        appGlobal.onRefresh = () => this.refreshData(true);
    }

    async refreshData(force: boolean): Promise<void> {
        ConnectClusterStore.connectClusters.clear();
        await api.refreshConnectClusters(force);

        // refresh topics so we know whether or not we can show the "go to error logs topic" button in the connector details error popup
        api.refreshTopics(force);
    }

    render() {
        const clusterName = decodeURIComponent(this.props.clusterName);
        const connectorName = decodeURIComponent(this.props.connector);

        if (api.connectConnectors?.isConfigured === false) return <NotConfigured />;

        return (
            <PageContent>
                <KafkaConnectorMain clusterName={clusterName} connectorName={connectorName} refreshData={this.refreshData} />
            </PageContent>
        );
    }
}

export default KafkaConnectorDetails;

const ConnectorDetails = observer((p: {
    clusterName: string,
    connectClusterStore: ConnectClusterStore,
    connector: ClusterConnectorInfo,
}) => {
    const store = p.connectClusterStore.getConnectorStore(p.connector.name);

    const allProps = [...store.propsByName.values()];

    const items = allProps
        .filter(x => {
            if (x.isHidden) return false;
            if (x.entry.definition.type == DataType.Password) return false;
            if (x.entry.definition.importance != PropertyImportance.High) return false;

            if (!x.value) return false;
            if (x.name == 'name') return false;

            return true;
        })
        .orderBy(x => {
            let i = 0;
            for (const s of store.connectorStepDefinitions)
                for (const g of s.groups)
                    for (const p of g.config_keys) {
                        if (p == x.name)
                            return i;
                        i++
                    }

            return 0;
        });

    const displayEntries = items.map(e => {
        const r = {
            name: e.entry.definition.display_name,
            value: String(e.value)
        };

        // Try to undo mapping
        if (e.entry.metadata.recommended_values?.length) {
            const match = e.entry.metadata.recommended_values.find(x => x.value == e.value);
            if (match) {
                r.value = String(match.display_name);
            }
        }

        return r;
    });

    displayEntries.unshift({
        name: 'Type',
        value: (p.connector.type == 'source' ? 'Import from' : 'Export to')
            + ' '
            + getConnectorFriendlyName(p.connector.class)
    });

    return <Grid templateColumns="auto 1fr" rowGap="3" columnGap="10">
        {displayEntries.map(x =>
            <React.Fragment key={x.name}>
                <Text fontWeight="semibold" whiteSpace="nowrap">{x.name}</Text>
                <Text whiteSpace="nowrap" textOverflow="ellipsis" overflow="hidden" title={x.value}>{x.value}</Text>
            </React.Fragment>
        )}
    </Grid>
});
